const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const UserAgent = require('user-agents');

// Plugins hinzufügen
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Ollama API URLs
const OLLAMA_API_URLS = [
    'http://127.0.0.1:11434/api/generate', // IPv4
    'http://[::1]:11434/api/generate'      // IPv6
];

// Helper function to extract key requirements
function extractKeyRequirements(description) {
    return description
        .split(/[.,\n]/)
        .filter(line => 
            line.toLowerCase().includes('anforderung') ||
            line.toLowerCase().includes('qualifikation') ||
            line.toLowerCase().includes('erwartet') ||
            line.toLowerCase().includes('mitbring')
        )
        .join('\n');
}

// Helper function to create a structured prompt
function createCoverLetterPrompt(jobData, userData) {
    return `Erstelle ein professionelles Anschreiben für folgende Stelle und Bewerber. 
    
STELLENINFORMATIONEN:
Titel: ${jobData.title}
Unternehmen: ${jobData.company}
Standort: ${jobData.location}
Wichtige Anforderungen:
${extractKeyRequirements(jobData.description)}

BEWERBER INFORMATIONEN:
Name: ${userData.name}
Email: ${userData.email}
Adresse: ${userData.address}
Telefon: ${userData.phone}
Qualifikationen: ${userData.qualifications}
Berufserfahrung: ${userData.experience}
Fähigkeiten: ${userData.skills}

ANWEISUNGEN:
    1. Schreibe ein formelles Anschreiben im deutschen Business-Format.
    2. Beginne das Dokument mit dem aktuellen Datum.
    3. Stelle eine klare und überzeugende Verbindung zwischen den Anforderungen der ausgeschriebenen Stelle und den Qualifikationen des Bewerbers her.
    4. Verwende einen professionellen, aber ansprechenden Schreibstil, der das Interesse des Lesers weckt.
    5. Schließe das Anschreiben mit einer motivierenden Call-to-Action ab, die den Wunsch nach einem persönlichen Gespräch signalisiert.
    6. Achte auf eine korrekte Formatierung, einschließlich sinnvoller Absätze und ausreichender Leerzeilen, um die Lesbarkeit zu gewährleisten.

FORMAT:
[Adresse des Bewerbers]

[Name des Unternehmens]
[Adresse des Unternehmens wenn vorhanden]

[Datum]

Betreff: Bewerbung als ${jobData.title}

[Anschreiben Text]

Mit freundlichen Grüßen

[Name des Bewerbers]
[Kontaktinformationen]`;
}

// Funktion zur Verbindungstest
async function checkOllamaConnection() {
    for (const url of OLLAMA_API_URLS) {
        try {
            await axios.get(url.replace('/generate', '/tags'), { timeout: 5000 });
            console.log(`✅ Verbindung erfolgreich: ${url}`);
            return url;
        } catch (error) {
            console.error(`❌ Fehler bei Verbindung zu ${url}: ${error.message}`);
        }
    }
    return null;
}

// Scraper-Logik
let browser = null;

async function initBrowser() {
    try {
        if (browser) {
            await browser.close();
        }

        const launchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080',
                '--disable-notifications',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-sync',
                '--enable-automation'
            ],
            ignoreHTTPSErrors: true,
            defaultViewport: {
                width: 1920,
                height: 1080
            }
        };

        browser = await puppeteer.launch(launchOptions);
        return browser;
    } catch (error) {
        console.error('Browser initialization failed:', error);
        throw error;
    }
}

async function setupPage() {
    if (!browser) {
        await initBrowser();
    }

    const page = await browser.newPage();

    // Zufälligen User-Agent setzen
    const userAgent = new UserAgent({ deviceCategory: 'desktop' });
    await page.setUserAgent(userAgent.toString());

    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    return { page };
}

async function scrapeJob(url, retryCount = 0) {
    let page = null;

    try {
        const setup = await setupPage();
        page = setup.page;

        console.log(`Navigating to URL: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        const jobData = await page.evaluate(() => {
            const getTextContent = (selector) => {
                const element = document.querySelector(selector);
                return element ? element.textContent.trim() : null;
            };

            const selectors = {
                title: ['.jobsearch-JobInfoHeader-title', '.job-title', 'h1[data-testid="jobsearch-JobInfoHeader-title"]'],
                company: ['.jobsearch-CompanyInfoContainer', '.company-name', '[data-testid="company-name"]'],
                location: ['.jobsearch-JobInfoHeader-subtitle', '.location', '[data-testid="job-location"]'],
                description: ['.jobsearch-JobComponent-description', '.job-description', '#jobDescriptionText']
            };

            const getData = (selectorArray) => {
                for (const selector of selectorArray) {
                    const content = getTextContent(selector);
                    if (content) return content;
                }
                return null;
            };

            return {
                title: getData(selectors.title) || 'Titel nicht gefunden',
                company: getData(selectors.company) || 'Firma nicht gefunden',
                location: getData(selectors.location) || 'Standort nicht gefunden',
                description: getData(selectors.description) || 'Beschreibung nicht gefunden'
            };
        });

        console.log('Data extracted successfully');
        return jobData;

    } catch (error) {
        console.error(`Scraping error (attempt ${retryCount + 1}):`, error);

        if (retryCount < 3) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            return scrapeJob(url, retryCount + 1);
        }
        throw error;

    } finally {
        if (page) await page.close();
    }
}

// API-Endpunkte
app.post('/api/scrape', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        console.log(`Starting scrape for URL: ${url}`);
        const jobData = await scrapeJob(url);

        res.json({
            status: 'success',
            jobDetails: jobData
        });

    } catch (error) {
        console.error('Final error:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to scrape job data',
            details: error.message
        });
    }
});

// Ollama-Bewerbungserstellung
app.post('/api/generate-letter', async (req, res) => {
    const { jobData, userData } = req.body;

    if (!jobData || !userData) {
        return res.status(400).json({
            status: 'error',
            message: 'Job data and user data are required'
        });
    }

    try {
        console.log('Erstelle personalisiertes Anschreiben...');
        const ollamaUrl = app.locals.ollamaUrl;

        if (!ollamaUrl) {
            throw new Error('Keine Verbindung zu Ollama');
        }

        const prompt = createCoverLetterPrompt(jobData, userData);

        const response = await axios.post(ollamaUrl, {
            model: 'llama3.2',
            prompt: prompt,
            stream: false
        });

        const coverLetter = response.data.response.trim();
        
        // Basic validation of the generated letter
        if (!coverLetter || coverLetter.length < 100) {
            throw new Error('Generated letter is too short or empty');
        }

        res.json({ status: 'success', coverLetter });

    } catch (error) {
        console.error('Error generating cover letter:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to generate cover letter',
            details: error.message
        });
    }
});

// Start-Up Check und Serverstart
(async () => {
    console.log('🔍 Überprüfe Ollama-Verbindung...');
    const ollamaUrl = await checkOllamaConnection();

    if (!ollamaUrl) {
        console.error('❌ Keine Verbindung zur Ollama-API. Stelle sicher, dass der Server läuft!');
        process.exit(1);
    }

    app.locals.ollamaUrl = ollamaUrl;

    console.log('🚀 Starte Server...');
    app.listen(port, () => {
        console.log(`Server läuft auf http://localhost:${port}`);
        console.log(`Ollama-API verbunden mit: ${ollamaUrl}`);
    });
})();