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
        // Sử dụng domcontentloaded thay vì networkidle để tránh timeout
        await page.goto(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, { 
            waitUntil: 'domcontentloaded',
            timeout: 15000 
        }).catch(err => console.log('Navigation warning:', err.message));
        
        // Chờ video items load với timeout ngắn hơn
        await page.waitForSelector('div[class*="search-result"]', { timeout: 5000 }).catch(() => null);
        await page.waitForTimeout(1500);

        // Logic trích xuất dữ liệu từ các thẻ HTML của TikTok
        const results = await page.evaluate(() => {
            // Lấy tất cả video items từ TikTok
            let items = [];
            
            // Selector 1: Data attribute
            items = Array.from(document.querySelectorAll('[data-e2e="search_video-item"]'));
            
            // Selector 2: Common TikTok video container
            if (items.length === 0) {
                items = Array.from(document.querySelectorAll('div[class*="feed-item"]'));
            }
            
            // Selector 3: Video link containers
            if (items.length === 0) {
                items = Array.from(document.querySelectorAll('a[href*="/video/"]')).map(a => a.closest('div[class*="container"]') || a.parentElement);
            }
            
            // Selector 4: Fallback to any strong tags within divs
            if (items.length === 0) {
                items = Array.from(document.querySelectorAll('div')).filter(div => {
                    return div.querySelector('a[href*="/video/"]') && div.querySelectorAll('strong').length > 0;
                });
            }
            
            return items.slice(0, 5).map(item => {
                // Lấy link video
                const linkEl = item.querySelector('a[href*="/video/"]') || item.querySelector('a');
                const link = linkEl?.href || '';
                
                // Lấy tất cả strong elements (thường là view và like)
                const stats = Array.from(item.querySelectorAll('strong'));
                
                let view = 'Unknown';
                let like = 'Unknown';
                
                if (stats.length >= 2) {
                    view = stats[0].innerText;  // View thường đầu tiên
                    like = stats[1].innerText;  // Like thường thứ hai
                } else if (stats.length === 1) {
                    view = stats[0].innerText;
                }
                
                // Lấy description
                const descElement = item.querySelector('[data-e2e="search_video-desc"]') || 
                                   item.querySelector('p') || 
                                   item.querySelector('span');
                
                return {
                    link_video: link,
                    like: view,
                    view: like,
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