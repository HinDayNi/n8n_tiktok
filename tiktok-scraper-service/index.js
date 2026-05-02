const { chromium } = require('playwright');
const express = require('express');
const app = express();

app.get('/scrape', async (req, res) => {
    const keyword = req.query.keyword;
    const browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();
    
    // Giả lập trình duyệt người dùng thật
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)...');
    
    try {
        await page.goto(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`);
        await page.waitForTimeout(3000); // Chờ load video

        // Logic trích xuất dữ liệu từ các thẻ HTML của TikTok
        const results = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('[data-e2e="search_video-item"]')).slice(0, 5);
            return items.map(item => ({
                link_video: item.querySelector('a')?.href,
                view: item.querySelector('[data-e2e="video-views"]')?.innerText,
                desc: item.querySelector('[data-e2e="search_video-desc"]')?.innerText
            }));
        });

        await browser.close();
        res.json(results);
    } catch (error) {
        await browser.close();
        res.status(500).send(error.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper service running on port ${PORT}`));