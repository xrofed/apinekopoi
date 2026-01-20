const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

// --- KONFIGURASI ---
const BASE_URL = 'https://hentaicop.com/hentai/page/';
const OUTPUT_FILE = 'urls_series.txt';

// Tentukan mau mulai dari halaman berapa sampai berapa
const START_PAGE = 1;  // Kamu minta mulai dari page 3
const MAX_PAGE = 120;   // Ubah ini mau sampai halaman berapa (misal: 50)

// Delay agar tidak dianggap spam/DDoS (ms)
const DELAY = 2000; 

// Fungsi Sleep/Delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeListPage() {
    console.log(`=== Memulai Scraper List (${START_PAGE} s/d ${MAX_PAGE}) ===`);
    
    // Opsional: Bersihkan file lama jika ingin mulai dari awal
    // fs.writeFileSync(OUTPUT_FILE, ''); 

    for (let page = START_PAGE; page <= MAX_PAGE; page++) {
        const targetUrl = `${BASE_URL}${page}/`;
        
        try {
            console.log(`\n[Halaman ${page}] Mengambil data dari: ${targetUrl}`);
            
            const { data } = await axios.get(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            const $ = cheerio.load(data);
            let count = 0;

            // Selector berdasarkan HTML yang kamu kirim:
            // <article class="bs"> -> <div class="bsx"> -> <a href="...">
            $('article.bs .bsx a').each((i, element) => {
                const link = $(element).attr('href');
                
                if (link) {
                    // Cek apakah link sudah ada di file (opsional, biar gak duplikat)
                    // Tapi untuk performa cepat, kita langsung append saja
                    fs.appendFileSync(OUTPUT_FILE, link + '\n');
                    count++;
                }
            });

            if (count === 0) {
                console.log(`   [!] Tidak ada series ditemukan di halaman ini. Mungkin halaman terakhir?`);
                break; // Berhenti jika tidak ada konten
            }

            console.log(`   [OK] Berhasil menyimpan ${count} URL ke ${OUTPUT_FILE}`);

            // Istirahat dulu biar aman
            await sleep(DELAY);

        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.log(`   [STOP] Halaman ${page} tidak ditemukan (404). Selesai.`);
                break;
            } else {
                console.error(`   [ERROR] Gagal mengambil halaman ${page}: ${error.message}`);
            }
        }
    }

    console.log('\n=== SELESAI ===');
    console.log(`Cek file "${OUTPUT_FILE}" untuk hasilnya.`);
}

scrapeListPage();