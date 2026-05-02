const { chromium } = require('playwright');
const express = require('express');
const app = express();

/** Lấy tất cả hashtag (#...) từ mô tả, nối bằng khoảng trắng */
function hashtagFromDesc(desc) {
    if (desc == null || typeof desc !== 'string') return '';
    const found = desc.match(/#[^\s#]+/g);
    return found ? found.join(' ') : '';
}

function mapVideo(v) {
    const desc = v?.desc ?? '';
    return {
        link_video:
            v?.author?.uniqueId && v?.id
                ? `https://www.tiktok.com/@${v.author.uniqueId}/video/${v.id}`
                : '',
        like: v?.stats?.diggCount ?? 'Unknown',
        view: v?.stats?.playCount ?? 'Unknown',
        comment: v?.stats?.commentCount ?? 'Unknown',
        desc,
        hashtag: hashtagFromDesc(desc)
    };
}

/** Search results today come from /api/search/general/full (blocks with type 1 + item). */
function videosFromSearchGeneralFull(json) {
    const out = [];
    const data = json?.data;
    if (!data || typeof data !== 'object') return out;
    for (const k of Object.keys(data)) {
        const block = data[k];
        if (block && block.type === 1 && block.item) out.push(block.item);
    }
    return out;
}

function dedupeVideosById(videos) {
    const seen = new Set();
    const out = [];
    for (const v of videos) {
        const id = v?.id;
        if (id == null || seen.has(String(id))) continue;
        seen.add(String(id));
        out.push(v);
    }
    return out;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function summarizeSearchApiResponses(records) {
    if (!records.length) {
        return 'Không thấy request /api/search/general/full (XHR không chạy hoặc URL khác phiên bản web).';
    }
    return records
        .map((r, i) => {
            const parts = [`#${i + 1} HTTP ${r.status}`];
            if (r.tiktok_status_code !== undefined) {
                parts.push(`TikTok status_code=${r.tiktok_status_code}`);
            }
            if (r.dataSlots !== undefined) {
                parts.push(`data.slots=${r.dataSlots}`);
            }
            if (r.parsedVideos !== undefined) {
                parts.push(`video type-1=${r.parsedVideos}`);
            }
            if (r.jsonError) parts.push(`json: ${r.jsonError}`);
            return parts.join(', ');
        })
        .join(' | ');
}

async function collectPageDiagnostics(page) {
    return page.evaluate(() => {
        const title = document.title || '';
        const href = location.href || '';
        const hasUni = !!document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
        const hasSigi = !!document.querySelector('#SIGI_STATE');
        let hydrationItemHint = null;
        const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (el) {
            try {
                const j = JSON.parse(el.innerText);
                const list = j?.__DEFAULT_SCOPE__?.webapp?.search?.itemList;
                if (Array.isArray(list)) hydrationItemHint = `itemList array length=${list.length}`;
                else if (list && typeof list === 'object') {
                    hydrationItemHint = `itemList object keys=${Object.keys(list).length}`;
                } else {
                    hydrationItemHint = 'itemList missing or empty in hydration';
                }
            } catch {
                hydrationItemHint = 'hydration script present but JSON parse failed';
            }
        }
        const text = (document.body?.innerText || '').slice(0, 500).toLowerCase();
        const pageHints = [];
        if (text.includes('captcha') || text.includes('verify')) pageHints.push('body mentions captcha/verify');
        if (text.includes('robot')) pageHints.push('body mentions robot');
        if (text.includes('log in') || text.includes('sign up')) pageHints.push('possible login wall');
        return {
            pageUrl: href.slice(0, 300),
            title: title.slice(0, 200),
            hasHydrationScript: hasUni,
            hasSigiState: hasSigi,
            hydrationSearchHint: hydrationItemHint,
            bodyTextHints: pageHints
        };
    });
}

/** Fallback: đọc JSON trong <script> — không dùng waitForSelector (script có thể không có khi bị chặn). */
async function tryHydrationVideos(page) {
    const maxWaitMs = Number(process.env.SCRAPE_HYDRATION_MS || 18000);
    const pollMs = Number(process.env.SCRAPE_HYDRATION_POLL_MS || 2000);
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
        const videos = await page.evaluate(() => {
            const script =
                document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__') ||
                document.querySelector('#SIGI_STATE');

            if (!script) return [];

            let json;
            try {
                json = JSON.parse(script.innerText);
            } catch {
                return [];
            }

            const items =
                json?.__DEFAULT_SCOPE__?.webapp?.search?.itemList ||
                json?.ItemModule ||
                {};

            if (Array.isArray(items)) return items;
            if (typeof items === 'object' && items !== null) {
                return Object.values(items);
            }
            return [];
        });

        if (videos.length > 0) return videos;
        await sleep(pollMs);
    }

    return [];
}

app.get('/scrape', async (req, res) => {
    const keyword = req.query.keyword;
    if (keyword == null || String(keyword).trim() === '') {
        return res.status(400).json({ error: 'Query parameter "keyword" is required' });
    }

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            // Tránh crash / chậm trên Docker (Render, v.v.)
            '--disable-dev-shm-usage'
        ]
    });

    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        const parseTasks = [];
        /** @type {Array<{ status: number, tiktok_status_code?: number, dataSlots?: number, parsedVideos?: number, jsonError?: string }>} */
        const searchApiResponses = [];

        const onSearchResponse = (response) => {
            if (!response.url().includes('/api/search/general/full')) return;
            const status = response.status();
            const rec = { status };
            searchApiResponses.push(rec);
            if (status !== 200) return;

            parseTasks.push(
                response
                    .json()
                    .then((j) => {
                        const videos = videosFromSearchGeneralFull(j);
                        rec.tiktok_status_code = j?.status_code;
                        rec.dataSlots =
                            j?.data && typeof j.data === 'object'
                                ? Object.keys(j.data).length
                                : 0;
                        rec.parsedVideos = videos.length;
                        return videos;
                    })
                    .catch((e) => {
                        rec.jsonError = e.message;
                        return [];
                    })
            );
        };
        page.on('response', onSearchResponse);

        await page.goto(
            `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`,
            { waitUntil: 'domcontentloaded', timeout: 60000 }
        );

        // Trên Render (CPU chậm / mạng): chờ XHR lâu hơn — chỉnh SCRAPE_SETTLE_MS
        const settleMs = Number(
            process.env.SCRAPE_SETTLE_MS ||
                (process.env.RENDER === 'true' ? 15000 : 8000)
        );
        await sleep(settleMs);
        page.off('response', onSearchResponse);

        const batches = await Promise.all(parseTasks);
        let rawVideos = dedupeVideosById(batches.flat());

        if (rawVideos.length === 0) {
            rawVideos = await tryHydrationVideos(page);
        }

        const results = rawVideos
            .slice(0, 5)
            .map(mapVideo)
            .filter((v) => v.link_video);

        let pageDiagnostics = null;
        if (results.length === 0) {
            pageDiagnostics = await collectPageDiagnostics(page);
        }

        await browser.close();

        if (results.length > 0) {
            return res.json(results);
        }

        const apiSummary = summarizeSearchApiResponses(searchApiResponses);
        const inferred =
            searchApiResponses.length === 0
                ? 'likely_no_xhr'
                : searchApiResponses.every((r) => r.status !== 200)
                  ? 'search_api_all_non_200'
                  : searchApiResponses.some(
                        (r) =>
                            r.status === 200 &&
                            r.parsedVideos === 0 &&
                            (r.dataSlots || 0) > 0
                    )
                    ? 'api_has_slots_but_no_type1_videos'
                    : searchApiResponses.some((r) => r.status === 200 && r.parsedVideos === 0)
                      ? 'api_200_empty_parse'
                      : 'unknown';

        const inferredVi = {
            likely_no_xhr:
                'Không bắt được XHR search — thường do trang không load đủ, bị chặn, hoặc endpoint đổi.',
            search_api_all_non_200:
                'Có gọi API search nhưng toàn bộ HTTP khác 200 (từ chối / lỗi máy chủ TikTok).',
            api_has_slots_but_no_type1_videos:
                'API 200 và có data nhưng không có block video (type 1) — có thể chỉ user/card khác hoặc format đổi.',
            api_200_empty_parse:
                'API 200 nhưng parse ra 0 video (body rỗng / không khớp parser).',
            unknown: 'Không xếp loại được — xem chi tiết searchApiResponses và page.'
        }[inferred] || inferred;

        return res.json({
            message: 'No videos found',
            debug: `${apiSummary} Trang: hydration=${pageDiagnostics?.hasHydrationScript ? 'có' : 'không'}, SIGI=${pageDiagnostics?.hasSigiState ? 'có' : 'không'}. Gợi ý: ${pageDiagnostics?.hydrationSearchHint || 'không đọc được itemList từ script'}.`,
            diagnostics: {
                settleMs,
                searchApiCalls: searchApiResponses.length,
                searchApiResponses,
                page: pageDiagnostics,
                inferredReason: inferred,
                inferredReasonVi: inferredVi,
                environment: {
                    render: process.env.RENDER === 'true',
                    node: process.version
                }
            }
        });
    } catch (error) {
        await browser.close();
        res.status(500).json({
            error: error.message,
            debug: 'Failed to scrape (Playwright / mạng / timeout)'
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
    console.log(`Scraper service running on port ${PORT}`)
);
