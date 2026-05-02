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

app.get('/scrape', async (req, res) => {
    const keyword = req.query.keyword;
    if (keyword == null || String(keyword).trim() === '') {
        return res.status(400).json({ error: 'Query parameter "keyword" is required' });
    }

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        const parseTasks = [];
        const onSearchResponse = (response) => {
            if (
                !response.url().includes('/api/search/general/full') ||
                response.status() !== 200
            ) {
                return;
            }
            parseTasks.push(
                response
                    .json()
                    .then((j) => videosFromSearchGeneralFull(j))
                    .catch(() => [])
            );
        };
        page.on('response', onSearchResponse);

        await page.goto(
            `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`,
            { waitUntil: 'domcontentloaded', timeout: 60000 }
        );

        // Search XHR often fires right after load; give time for handlers + JSON bodies
        await new Promise((r) => setTimeout(r, 8000));
        page.off('response', onSearchResponse);

        const batches = await Promise.all(parseTasks);
        let rawVideos = dedupeVideosById(batches.flat());

        if (rawVideos.length === 0) {
            await page.waitForSelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__, #SIGI_STATE', {
                state: 'attached',
                timeout: 15000
            });

            rawVideos = await page.evaluate(() => {
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

                let videos = [];
                if (Array.isArray(items)) videos = items;
                else if (typeof items === 'object' && items !== null) {
                    videos = Object.values(items);
                }
                return videos;
            });
        }

        const results = rawVideos
            .slice(0, 5)
            .map(mapVideo)
            .filter((v) => v.link_video);

        await browser.close();

        res.json(
            results.length > 0
                ? results
                : { message: 'No videos found', debug: 'JSON not found or empty' }
        );
    } catch (error) {
        await browser.close();
        res.status(500).json({
            error: error.message,
            debug: 'Failed to scrape JSON'
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
    console.log(`Scraper service running on port ${PORT}`)
);
