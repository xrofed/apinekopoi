const express = require('express');
const router = express.Router();
const slugify = require('slugify');
const NodeCache = require('node-cache');
const appCache = new NodeCache({ stdTTL: 3600 });
const axios = require('axios'); // <--- TAMBAHAN 1: Import Axios
const ITEMS_PER_PAGE = 20;

const Anime = require('./models/Anime');
const Episode = require('./models/Episode');

// --- HELPER SCRAPER (INTEGRASI DARI PLAYER.JS) ---
// Fungsi ini bertugas mengambil source code dan mencari URL .m3u8
async function scrapeSaitou(url) {
  try {
    // Header agar request terlihat seperti browser asli
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      'Referer': 'https://saitou.my.id/', 
    };

    const response = await axios.get(url, { headers, timeout: 5000 }); // Timeout 5 detik biar ga hanging
    const html = response.data;

    // Regex untuk mencari "file":"https://..." di dalam config player
    const regex = /"file"\s*:\s*"([^"]+)"/;
    const match = html.match(regex);

    if (match && match[1]) {
      // Bersihkan URL (Hapus backslashes "\" escape character JSON)
      let videoUrl = match[1].replace(/\\\//g, '/');
      return { success: true, url: videoUrl, type: 'hls' };
    } else {
      return { success: false, message: 'Source pattern not found' };
    }
  } catch (error) {
    console.error("Scrape Error:", error.message);
    return { success: false, message: error.message };
  }
}

const encodeAnimeSlugs = (animes) => {
  return animes.map(anime => ({
    ...anime,
    pageSlug: anime.pageSlug || slugify(anime.title, { lower: true, strict: true })
  }));
};

// --- ROUTE BARU: EXTRACT STREAM ---
// Frontend akan memanggil ini: /api/extract?url=https://saitou.my.id/embed/...
router.get('/extract', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
      return res.status(400).json({ success: false, message: 'URL parameter is required' });
    }

    // Cek apakah URL ini adalah target scraper kita (Saitou)
    if (targetUrl.includes('saitou.my.id') || targetUrl.includes('embed')) {
      const result = await scrapeSaitou(targetUrl);
      
      if (result.success) {
        return res.status(200).json({ success: true, data: result });
      } else {
        return res.status(422).json({ success: false, message: 'Failed to extract video', debug: result.message });
      }
    }

    // Jika URL bukan target scraper (misal file MP4 langsung), kembalikan apa adanya
    return res.status(200).json({ success: true, data: { url: targetUrl, type: 'direct' } });

  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- HOME ---
router.get('/home', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * ITEMS_PER_PAGE;

    const [episodes, totalCount, latestSeries] = await Promise.all([
      Episode.find().sort({ updatedAt: -1 }).skip(skip).limit(20).lean(),
      Episode.countDocuments(),
      Anime.find().sort({ createdAt: -1 }).limit(20).select('pageSlug imageUrl title info.Type info.Released info.Status').lean()
    ]);

    const formattedEpisodes = episodes.map(ep => ({
      watchUrl: `/watch${ep.episodeSlug}`, 
      title: ep.title,
      imageUrl: ep.animeImageUrl || '/images/default.jpg',
      quality: '720p',
      year: new Date(ep.updatedAt || ep.createdAt).getFullYear().toString(),
      createdAt: ep.updatedAt || ep.createdAt
    }));

    res.status(200).json({
      success: true,
      data: {
        episodes: formattedEpisodes,
        latestSeries: latestSeries
      },
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE),
        totalItems: totalCount,
        hasNextPage: page < Math.ceil(totalCount / ITEMS_PER_PAGE)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- TRENDING ---
router.get('/trending', async (req, res) => {
  try {
    const animes = await Anime.find().sort({ viewCount: -1 }).limit(20).lean();
    res.status(200).json({ success: true, data: { animes: encodeAnimeSlugs(animes) } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// --- SEARCH ---
router.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    const page = parseInt(req.query.page) || 1;
    const limit = ITEMS_PER_PAGE; // Pastikan konstanta ini ada
    const skip = (page - 1) * limit;

    if (!q) return res.status(400).json({ success: false, message: 'Query parameter "q" is required' });
    
    // Gunakan regex untuk pencarian (Case Insensitive)
    const query = { title: { $regex: new RegExp(q, 'i') } };

    const [animes, totalCount] = await Promise.all([
      Anime.find(query)
        .sort({ createdAt: -1 }) // Urutkan dari yang terbaru
        .skip(skip)
        .limit(limit)
        // UPDATE: Pilih field penting untuk AnimeCard (Status, Type, Released)
        .select('title pageSlug imageUrl info.Status info.Type info.Released rating viewCount') 
        .lean(),
      Anime.countDocuments(query)
    ]);
    
    res.status(200).json({
      success: true,
      data: { query: q, animes: encodeAnimeSlugs(animes) },
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
        totalItems: totalCount,
        hasNextPage: page < Math.ceil(totalCount / limit)
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GENRE DETAIL (LIST ANIME BY GENRE) ---
router.get('/genre/:genreSlug', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = ITEMS_PER_PAGE; // Pastikan konstanta ini ada
    const skip = (page - 1) * limit;

    // Ambil daftar genre dari cache atau DB
    let allGenres = appCache.get('allGenres');
    if (!allGenres) { 
      allGenres = await Anime.distinct('genres'); 
      appCache.set('allGenres', allGenres); 
    }
    
    // Cari nama genre asli berdasarkan slug URL
    const originalGenre = allGenres.find(g => 
      slugify(g, { lower: true, strict: true }) === req.params.genreSlug
    );
    
    if (!originalGenre) return res.status(404).json({ success: false, message: 'Genre not found' });

    const query = { genres: { $regex: new RegExp(`^${originalGenre}$`, 'i') } };

    const [animes, totalCount] = await Promise.all([
      Anime.find(query)
        .sort({ createdAt: -1 }) // Urutkan dari yang terbaru ditambahkan
        .skip(skip)
        .limit(limit)
        // UPDATE: Select field penting untuk AnimeCard (Status, Type, Released)
        .select('title pageSlug imageUrl info.Status info.Type info.Released rating viewCount')
        .lean(),
      Anime.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: { 
        genreName: originalGenre, 
        animes: encodeAnimeSlugs(animes) 
      },
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
        totalItems: totalCount,
        hasNextPage: page < Math.ceil(totalCount / limit)
      }
    });

  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- EPISODE DETAIL (NONTON) ---
router.get('/watch/:slug', async (req, res) => {
  try {
    const episodeSlug = `/${req.params.slug}`;
    
    const [episodeData, recommendations, latestSeries] = await Promise.all([
      Episode.findOne({ episodeSlug }).lean(),
      Anime.aggregate([{ $sample: { size: 10 } }]),
      Anime.find({}).sort({ createdAt: -1 }).limit(20).select('pageSlug imageUrl title info.Type info.Released info.Status').lean()
    ]);

    if (!episodeData) {
      return res.status(404).json({ success: false, message: 'Episode not found (Slug mismatch?)', requestedSlug: episodeSlug });
    }

    const parentAnime = await Anime.findOne({ pageSlug: episodeData.animeSlug }).lean();

    if (parentAnime) {
      Anime.updateOne({ _id: parentAnime._id }, { $inc: { viewCount: 1 } }, { timestamps: false }).exec().catch(() => {});
    }

    if (episodeData.streaming) {
      episodeData.streaming = episodeData.streaming.map(s => ({ 
        ...s, 
        // Kita biarkan Base64, nanti frontend yang decode dan kirim ke /api/extract jika perlu
        url: s.url ? Buffer.from(s.url).toString('base64') : null 
      }));
    }

    const nav = { prev: null, next: null, all: null };
    if (parentAnime && parentAnime.episodes) {
      nav.all = `/anime/${parentAnime.pageSlug}`;
      const idx = parentAnime.episodes.findIndex(ep => ep.url === episodeSlug);
      
      if (idx > -1) {
        if (idx < parentAnime.episodes.length - 1) { 
           const prevEp = parentAnime.episodes[idx + 1];
           nav.prev = { title: prevEp.title, url: `/watch${prevEp.url}` };
        }
        if (idx > 0) { 
           const nextEp = parentAnime.episodes[idx - 1];
           nav.next = { title: nextEp.title, url: `/watch${nextEp.url}` };
        }
      }
    }

    res.status(200).json({
      success: true,
      data: {
        episode: episodeData,
        parentAnime: parentAnime ? {
          title: parentAnime.title,
          slug: parentAnime.pageSlug,
          imageUrl: parentAnime.imageUrl,
          synopsis: parentAnime.synopsis,
          episodes: parentAnime.episodes
        } : null,
        navigation: nav,
        recommendations: encodeAnimeSlugs(recommendations),
        latestSeries: latestSeries
      }
    });

  } catch (error) { 
    console.error("Nonton Error:", error);
    res.status(500).json({ success: false, message: error.message }); 
  }
});

// --- ANIME DETAIL (SERIES) ---
router.get('/anime/:slug', async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    const [animeData, recommendations] = await Promise.all([
      Anime.findOne({ pageSlug }).lean(),
      Anime.aggregate([{ $match: { pageSlug: { $ne: pageSlug } } }, { $sample: { size: 10 } }])
    ]);

    if (!animeData) {
      return res.status(404).json({ success: false, message: 'Anime not found' });
    }

    Anime.updateOne({ pageSlug }, { $inc: { viewCount: 1 } }, { timestamps: false }).exec().catch(() => {});

    animeData.episodes = animeData.episodes?.map(ep => ({ 
      ...ep, 
      watchUrl: `/watch${ep.url}`
    })) || [];

    res.status(200).json({
      success: true,
      data: {
        anime: animeData,
        recommendations: encodeAnimeSlugs(recommendations)
      }
    });
  } catch (error) { 
    res.status(500).json({ success: false, message: error.message });
  }
});


// --- PROXY ROUTE (SOLUSI CORS) ---
router.get('/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    // Tentukan URL Backend kita sendiri untuk rewriting
    // Ganti port 3000 sesuai port backendmu jika beda
    const myBackendUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=`;

    // Header palsu agar tidak diblokir server asli
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      'Referer': 'https://saitou.my.id/', 
      'Origin': 'https://saitou.my.id/'
    };

    // Request ke server video asli
    const response = await axios({
      url: targetUrl,
      method: 'GET',
      responseType: 'stream', // Penting untuk streaming video
      headers: headers
    });

    // Copy header penting dari server asli ke browser kita
    if (response.headers['content-type']) {
      res.setHeader('Content-Type', response.headers['content-type']);
    }
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    // IZINKAN CORS DI SINI
    res.setHeader('Access-Control-Allow-Origin', '*');

    // LOGIKA KHUSUS M3U8 (REWRITING)
    // Jika file adalah playlist (m3u8), kita harus mengedit isinya
    const contentType = response.headers['content-type'];
    if (contentType && (contentType.includes('mpegurl') || targetUrl.includes('.m3u8'))) {
      
      // Ubah stream jadi string dulu
      let m3u8Content = '';
      response.data.on('data', (chunk) => { m3u8Content += chunk; });
      
      response.data.on('end', () => {
        // Regex untuk mencari URL http/https di dalam file m3u8
        // Dan membungkusnya dengan proxy kita
        const rewrittenContent = m3u8Content.replace(
          /(https?:\/\/[^\s]+)/g, 
          (match) => `${myBackendUrl}${encodeURIComponent(match)}`
        );
        
        // Kirim hasil edit ke browser
        res.send(rewrittenContent);
      });

    } else {
      // Jika file video biasa (.ts / .mp4), langsung pipe (alirkan) saja
      response.data.pipe(res);
    }

  } catch (error) {
    console.error("Proxy Error:", error.message);
    res.status(500).send("Proxy Error");
  }
});

router.get('/genres', async (req, res) => {
  try {
    // Cek cache dulu agar tidak membebani database
    let allGenres = appCache.get('allGenres');
    
    if (!allGenres) { 
      // Ambil semua genre unik dari database
      allGenres = await Anime.distinct('genres'); 
      // Urutkan abjad A-Z
      allGenres.sort();
      // Simpan di cache selama 1 jam
      appCache.set('allGenres', allGenres); 
    }

    res.status(200).json({
      success: true,
      data: allGenres
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- ANIME LIST (DIRECTORY) ---
// Bisa filter: ?page=1&sort=latest|oldest|az|za&status=Ongoing|Completed
// --- ANIME LIST (DIRECTORY) ---
router.get('/animes', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const sort = req.query.sort || 'latest';
    const status = req.query.status;
    const limit = ITEMS_PER_PAGE;
    const skip = (page - 1) * limit;

    // Build Query
    let query = {};
    if (status) {
      query['info.Status'] = { $regex: new RegExp(`^${status}$`, 'i') };
    }

    // Tentukan Sorting
    let sortOption = { createdAt: -1 };
    if (sort === 'oldest') sortOption = { createdAt: 1 };
    else if (sort === 'az') sortOption = { title: 1 };
    else if (sort === 'za') sortOption = { title: -1 };
    else if (sort === 'popular') sortOption = { viewCount: -1 };

    const [animes, totalCount] = await Promise.all([
      Anime.find(query)
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        // UPDATE: Tambahkan 'info.Released' agar tahun rilis muncul di frontend
        .select('title pageSlug imageUrl info.Status info.Type info.Released rating viewCount') 
        .lean(),
      Anime.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: encodeAnimeSlugs(animes),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
        totalItems: totalCount,
        hasNextPage: page < Math.ceil(totalCount / limit)
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- EPISODE LIST (NEW RELEASES) ---
router.get('/episodes', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = ITEMS_PER_PAGE;
    const skip = (page - 1) * limit;

    const [episodes, totalCount] = await Promise.all([
      Episode.find()
        .sort({ updatedAt: -1 }) 
        .skip(skip)
        .limit(limit)
        .lean(),
      Episode.countDocuments()
    ]);

    // Format data agar seragam dengan frontend
    const formattedEpisodes = episodes.map(ep => {
      // Logic sederhana untuk menentukan Quality jika tidak ada di DB
      // Bisa diambil dari ep.quality atau default ke 'HD'
      const quality = ep.quality || 'HD'; 
      
      // Ambil tahun dari tanggal update/create
      const dateObj = new Date(ep.updatedAt || ep.createdAt);
      const year = dateObj.getFullYear();

      return {
        title: ep.title,
        watchUrl: `/watch${ep.episodeSlug}`,
        imageUrl: ep.animeImageUrl || '/images/default.jpg',
        animeTitle: ep.animeTitle,
        releasedAt: ep.updatedAt || ep.createdAt,
        // UPDATE: Tambahkan field quality dan year untuk Badge Frontend
        quality: quality,
        year: year
      };
    });

    res.status(200).json({
      success: true,
      data: formattedEpisodes,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
        totalItems: totalCount,
        hasNextPage: page < Math.ceil(totalCount / limit)
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;