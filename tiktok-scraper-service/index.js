const { chromium } = require('playwright');
const express = require('express');
const app = express();

// Function to create a new browser context with anti-detection measures
async function createBrowser() {
    return await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process'
        ]
    });
}

// Function to retry a request with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            const delay = initialDelay * Math.pow(2, i);
            console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms:`, error.message);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

app.get('/scrape', async (req, res) => {
    const keyword = req.query.keyword;
    let browser;
    
    try {
        browser = await createBrowser();
        
        // Create context with advanced anti-detection
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            extraHTTPHeaders: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            },
            viewport: { width: 1920, height: 1080 },
            bypassCSP: true,
            javaScriptEnabled: true
        });
        
        const page = await context.newPage();
        
        // Set custom headers to look more like a real browser
        await page.setExtraHTTPHeaders({
            'Referer': 'https://www.tiktok.com/',
            'Origin': 'https://www.tiktok.com'
        });
        
        // Inject script to hide automation signals
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
        });
        
        // Navigate with retry
        await retryWithBackoff(async () => {
            await page.goto(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, { 
                waitUntil: 'load',
                timeout: 25000 
            });
        }, 2, 2000);
        
        // Scroll to trigger video loading
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(2000);
        
        // Try to wait for videos to load
        try {
            await Promise.race([
                page.waitForSelector('[data-e2e="search_video-item"]', { timeout: 5000 }),
                page.waitForSelector('a[href*="/video/"]', { timeout: 5000 }),
                page.waitForSelector('article', { timeout: 5000 })
            ]);
        } catch (e) {
            console.log('No specific selector found, proceeding with content extraction');
        }
        
        await page.waitForTimeout(1500);

        // Get page content for debugging
        const pageContent = await page.evaluate(() => ({
            title: document.title,
            url: window.location.href,
            bodyLength: document.body.innerHTML.length
        }));
        
        console.log('Page loaded:', pageContent);

        // Logic trích xuất dữ liệu từ các thẻ HTML của TikTok
        const results = await page.evaluate(() => {
            // Strategy: Try multiple approaches to find videos
            const getAllVideos = () => {
                let videos = [];
                
                // Approach 1: Look for video links directly
                const videoLinks = document.querySelectorAll('a[href*="/video/"]');
                console.log('Found video links:', videoLinks.length);
                
                if (videoLinks.length > 0) {
                    videos = Array.from(videoLinks).map(link => {
                        const container = link.closest('div') || link.parentElement;
                        return {
                            link: link.href,
                            container: container
                        };
                    });
                }
                
                // Approach 2: If that didn't work, look for search item containers
                if (videos.length === 0) {
                    const searchItems = document.querySelectorAll('[data-e2e="search_video-item"]');
                    console.log('Found search items:', searchItems.length);
                    videos = Array.from(searchItems).map(item => ({
                        link: item.querySelector('a')?.href || '',
                        container: item
                    }));
                }
                
                // Approach 3: Look for articles
                if (videos.length === 0) {
                    const articles = document.querySelectorAll('article');
                    console.log('Found articles:', articles.length);
                    videos = Array.from(articles).map(article => ({
                        link: article.querySelector('a[href*="/video/"]')?.href || '',
                        container: article
                    }));
                }
                
                return videos.filter(v => v.link);
            };
            
            const videoItems = getAllVideos().slice(0, 5);
            console.log('Processing videos:', videoItems.length);
            
            return videoItems.map((item, idx) => {
                const container = item.container;
                
                // Extract statistics
                const strongTags = Array.from(container.querySelectorAll('strong'));
                let view = 'Unknown';
                let like = 'Unknown';
                
                if (strongTags.length >= 2) {
                    view = strongTags[0].textContent.trim();
                    like = strongTags[1].textContent.trim();
                } else if (strongTags.length === 1) {
                    view = strongTags[0].textContent.trim();
                }
                
                // Extract description
                let desc = 'No description';
                const descElem = container.querySelector('[data-e2e="search_video-desc"]') ||
                               container.querySelector('h3') ||
                               container.querySelector('p') ||
                               container.querySelector('span:not(strong)');
                if (descElem) {
                    desc = descElem.textContent.trim().substring(0, 100);
                }
                
                return {
                    link_video: item.link,
                    view: view,
                    like: like,
                    desc: desc
                };
            });
        });
        
        console.log('Results found:', results.length);

        await browser.close();
        res.json({
            success: results.length > 0,
            count: results.length,
            data: results
        });
        
    } catch (error) {
        console.error('Scraping error:', error);
        if (browser) await browser.close();
        res.status(500).json({ 
            success: false,
            error: error.message,
            stack: error.stack 
        });
    }
});

const PORT = process.env.PORT || 3000;

// Debug endpoint to troubleshoot page content
app.get('/debug', async (req, res) => {
    const keyword = req.query.keyword || 'test';
    let browser;
    
    try {
        browser = await createBrowser();
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            bypassCSP: true
        });
        const page = await context.newPage();
        
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        
        await retryWithBackoff(async () => {
            await page.goto(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, { 
                waitUntil: 'load',
                timeout: 25000 
            });
        }, 2, 2000);
        
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(3000);
        
        const debugInfo = await page.evaluate(() => {
            return {
                pageTitle: document.title,
                pageUrl: window.location.href,
                selectors: {
                    'data-e2e-video-items': document.querySelectorAll('[data-e2e="search_video-item"]').length,
                    'video-links': document.querySelectorAll('a[href*="/video/"]').length,
                    'articles': document.querySelectorAll('article').length,
                    'strong-tags': document.querySelectorAll('strong').length,
                    'h3-tags': document.querySelectorAll('h3').length
                },
                contentLoaded: document.body.innerHTML.length > 5000
            };
        });
        
        await browser.close();
        res.json({
            success: true,
            debug: debugInfo
        });
        
    } catch (error) {
        console.error('Debug error:', error);
        if (browser) await browser.close();
        res.status(500).json({ 
            success: false,
            error: error.message
        });
    }
});

app.listen(PORT, () => console.log(`Scraper service running on port ${PORT}`));