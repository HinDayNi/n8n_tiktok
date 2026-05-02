const { chromium } = require('playwright');
const express = require('express');
const app = express();

app.get('/scrape', async (req, res) => {
    const keyword = req.query.keyword;
    const browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    // Giả lập trình duyệt người dùng thật
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    const page = await context.newPage();
    
    try {
        await page.goto(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, { waitUntil: 'networkidle' });
        
        // Chờ video items load
        await page.waitForSelector('div[class*="search-result"]', { timeout: 10000 }).catch(() => null);
        await page.waitForTimeout(2000);

        // Logic trích xuất dữ liệu từ các thẻ HTML của TikTok
        const results = await page.evaluate(() => {
            // Thử nhiều selectors khác nhau
            let items = Array.from(document.querySelectorAll('[data-e2e="search_video-item"]'));
            
            if (items.length === 0) {
                items = Array.from(document.querySelectorAll('div[class*="search-result"]'));
            }
            
            if (items.length === 0) {
                items = Array.from(document.querySelectorAll('a[href*="/video/"]'));
            }
            
            return items.slice(0, 5).map(item => {
                const link = item.querySelector('a')?.href || item.href || '';
                
                // Lấy view
                const viewElement = item.querySelector('[data-e2e="video-views"]') || 
                                   item.querySelector('span[class*="view"]') ||
                                   item.querySelector('strong');
                
                // Lấy like
                const likeElement = item.querySelector('[data-e2e="video-likes"]') || 
                                   item.querySelector('span[class*="like"]') ||
                                   item.querySelector('[class*="favorite"]');
                
                // Lấy description
                const descElement = item.querySelector('[data-e2e="search_video-desc"]') || 
                                   item.querySelector('p') || 
                                   item.querySelector('span[class*="desc"]');
                
                return {
                    link_video: link,
                    like: viewElement?.innerText || 'Unknown',
                    view: likeElement?.innerText || 'Unknown',
                    desc: descElement?.innerText || 'No description'
                };
            }).filter(item => item.link_video); // Chỉ giữ items có link
        });

        await browser.close();
        res.json(results.length > 0 ? results : { message: 'No videos found', debug: 'Check TikTok selectors' });
    } catch (error) {
        await browser.close();
        res.status(500).json({ error: error.message, debug: 'Failed to scrape' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper service running on port ${PORT}`));