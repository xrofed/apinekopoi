const express = require('express');
const router = express.Router();
const slugify = require('slugify');
const NodeCache = require('node-cache');
const appCache = new NodeCache({ stdTTL: 3600 });
const axios = require('axios');
const ITEMS_PER_PAGE = 20;

const Anime = require('./models/Anime');
const Episode = require('./models/Episode');

// --- HELPER FUNCTIONS ---
async function scrapeSaitou(url) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      'Referer': 'https://saitou.my.id/', 
    };
    const response = await axios.get(url, { headers, timeout: 5000 });
    const html = response.data;
    const regex = /"file"\s*:\s*"([^"]+)"/;
    const match = html.match(regex);
    if (match && match[1]) {
      let videoUrl = match[1].replace(/\\\//g, '/');
      return { success: true, url: videoUrl, type: 'hls' };
    }
    return { success: false, message: 'Source pattern not found' };
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

// --- ROUTE: EXTRACT STREAM ---
router.get('/extract', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ success: false, message: 'URL required' });

    if (targetUrl.includes('saitou.my.id') || targetUrl.includes('embed')) {
      const result = await scrapeSaitou(targetUrl);
      if (result.success) return res.status(200).json({ success: true, data: result });
      return res.status(422).json({ success: false, message: 'Failed to extract video' });
    }
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

    const [episodesRaw, totalCount, latestSeries] = await Promise.all([
      Episode.find().sort({ updatedAt: -1 }).skip(skip).limit(20).lean(),
      Episode.countDocuments(),
      Anime.find().sort({ createdAt: -1 }).limit(20).select('pageSlug imageUrl title info.Type info.Released info.Status').lean()
    ]);

    const animeSlugs = [...new Set(episodesRaw.map(ep => ep.animeSlug).filter(Boolean))];
    const animeImages = await Anime.find({ pageSlug: { $in: animeSlugs } })
      .select('pageSlug imageUrl')
      .lean();

    const imageMap = {};
    animeImages.forEach(a => { imageMap[a.pageSlug] = a.imageUrl; });

    const formattedEpisodes = episodesRaw.map(ep => ({
      watchUrl: `/watch${ep.episodeSlug}`, 
      title: ep.title,
      imageUrl: imageMap[ep.animeSlug] || ep.animeImageUrl || '/images/default.jpg',
      quality: '720p',
      year: new Date(ep.updatedAt || ep.createdAt).getFullYear().toString(),
      createdAt: ep.updatedAt || ep.createdAt
    }));

    res.status(200).json({
      success: true,
      data: { episodes: formattedEpisodes, latestSeries },
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
    const skip = (page - 1) * ITEMS_PER_PAGE;

    if (!q) return res.status(400).json({ success: false, message: 'Query required' });
    
    // [FIX] Gunakan $regex untuk pencarian case-insensitive yang aman
    const query = { title: { $regex: new RegExp(q, 'i') } };

    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ createdAt: -1 }).skip(skip).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    
    res.status(200).json({
      success: true,
      data: { query: q, animes: encodeAnimeSlugs(animes) },
      pagination: { currentPage: page, totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE) }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GENRE DETAIL ---
router.get('/genre/:genreSlug', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * ITEMS_PER_PAGE;
    
    let allGenres = appCache.get('allGenres');
    if (!allGenres) { 
      allGenres = await Anime.distinct('genres'); 
      appCache.set('allGenres', allGenres); 
    }
    
    const originalGenre = allGenres.find(g => 
      slugify(g, { lower: true, strict: true }) === req.params.genreSlug
    );
    
    if (!originalGenre) return res.status(404).json({ success: false, message: 'Genre not found' });

    const query = { genres: { $regex: new RegExp(`^${originalGenre}$`, 'i') } };

    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ createdAt: -1 }).skip(skip).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: { genreName: originalGenre, animes: encodeAnimeSlugs(animes) },
      pagination: { currentPage: page, totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE) }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- WATCH / EPISODE DETAIL (FIX KARAKTER SPESIAL) ---
router.get('/watch/:slug', async (req, res) => {
  try {
    // [FIX] Decode URI Component agar %e2%99%a5 terbaca sebagai ♥
    // Dan tambahkan '/' di depan karena di DB formatnya '/judul-episode'
    let rawSlug = req.params.slug;
    
    // Jika user mengirim full path (ada / di depan), decode saja
    // Jika tidak, tambahkan /. Decode penting untuk simbol.
    const episodeSlug = rawSlug.startsWith('/') 
      ? decodeURIComponent(rawSlug) 
      : `/${decodeURIComponent(rawSlug)}`;
    
    // console.log("Mencari Episode dengan slug:", episodeSlug); // Debugging

    const [episodeData, recommendations, latestSeries] = await Promise.all([
      Episode.findOne({ episodeSlug }).lean(),
      Anime.aggregate([{ $sample: { size: 10 } }]),
      Anime.find({}).sort({ createdAt: -1 }).limit(20).select('pageSlug imageUrl title info.Type info.Released info.Status').lean()
    ]);

    if (!episodeData) {
      return res.status(404).json({ success: false, message: 'Episode not found', requestedSlug: episodeSlug });
    }

    const parentAnime = await Anime.findOne({ pageSlug: episodeData.animeSlug }).lean();

    if (parentAnime) {
      Anime.updateOne({ _id: parentAnime._id }, { $inc: { viewCount: 1 } }, { timestamps: false }).exec().catch(() => {});
      
      // Sort episodes by index descending
      if (parentAnime.episodes && Array.isArray(parentAnime.episodes)) {
        parentAnime.episodes.sort((a, b) => (b.episode_index || 0) - (a.episode_index || 0));
      }
    }

    if (episodeData.streaming) {
      episodeData.streaming = episodeData.streaming.map(s => ({ 
        ...s, 
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
    console.error("Watch Error:", error);
    res.status(500).json({ success: false, message: error.message }); 
  }
});

// --- ANIME DETAIL (FIX KARAKTER SPESIAL) ---
router.get('/anime/:slug', async (req, res) => {
  try {
    // [FIX] Decode URI Component agar %e2%99%a5 terbaca sebagai ♥
    const pageSlug = decodeURIComponent(req.params.slug);
    
    // console.log("Mencari Anime dengan slug:", pageSlug); // Debugging

    const [animeData, recommendations] = await Promise.all([
      Anime.findOne({ pageSlug }).lean(),
      Anime.aggregate([{ $match: { pageSlug: { $ne: pageSlug } } }, { $sample: { size: 10 } }])
    ]);

    if (!animeData) {
      return res.status(404).json({ success: false, message: 'Anime not found', requestedSlug: pageSlug });
    }

    Anime.updateOne({ pageSlug }, { $inc: { viewCount: 1 } }, { timestamps: false }).exec().catch(() => {});

    if (animeData.episodes && Array.isArray(animeData.episodes)) {
        animeData.episodes.sort((a, b) => (b.episode_index || 0) - (a.episode_index || 0));
    }

    // Pastikan watchUrl juga menggunakan slug yang benar
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

// --- PROXY ROUTE (FIX HTTPS) ---
router.get('/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");
    
    const myBackendUrl = `https://${req.get('host')}/api/proxy?url=`;
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      'Referer': 'https://saitou.my.id/', 
      'Origin': 'https://saitou.my.id/'
    };

    const response = await axios({
      url: targetUrl, method: 'GET', responseType: 'stream', headers
    });

    if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
    res.setHeader('Access-Control-Allow-Origin', '*');

    const contentType = response.headers['content-type'];
    if (contentType && (contentType.includes('mpegurl') || targetUrl.includes('.m3u8'))) {
      let m3u8Content = '';
      response.data.on('data', (chunk) => { m3u8Content += chunk; });
      response.data.on('end', () => {
        const rewrittenContent = m3u8Content.replace(
          /(https?:\/\/[^\s]+)/g, 
          (match) => `${myBackendUrl}${encodeURIComponent(match)}`
        );
        res.send(rewrittenContent);
      });
    } else {
      response.data.pipe(res);
    }
  } catch (error) {
    console.error("Proxy Error:", error.message);
    res.status(500).send("Proxy Error");
  }
});

// --- GENRES LIST ---
router.get('/genres', async (req, res) => {
  try {
    let allGenres = appCache.get('allGenres');
    if (!allGenres) { 
      allGenres = await Anime.distinct('genres'); 
      allGenres.sort();
      appCache.set('allGenres', allGenres); 
    }
    res.status(200).json({ success: true, data: allGenres });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// --- ANIME DIRECTORY ---
router.get('/animes', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const sort = req.query.sort || 'latest';
    const status = req.query.status;
    const skip = (page - 1) * ITEMS_PER_PAGE;

    let query = {};
    if (status) query['info.Status'] = { $regex: new RegExp(`^${status}$`, 'i') };

    let sortOption = { createdAt: -1 };
    if (sort === 'oldest') sortOption = { createdAt: 1 };
    else if (sort === 'az') sortOption = { title: 1 };
    else if (sort === 'za') sortOption = { title: -1 };
    else if (sort === 'popular') sortOption = { viewCount: -1 };

    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort(sortOption).skip(skip).limit(ITEMS_PER_PAGE).select('title pageSlug imageUrl info.Status info.Type info.Released rating viewCount').lean(),
      Anime.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: encodeAnimeSlugs(animes),
      pagination: { currentPage: page, totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE) }
    });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// --- EPISODES LIST ---
router.get('/episodes', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * ITEMS_PER_PAGE;

    const [episodesRaw, totalCount] = await Promise.all([
      Episode.find().sort({ updatedAt: -1 }).skip(skip).limit(ITEMS_PER_PAGE).lean(),
      Episode.countDocuments()
    ]);

    const animeSlugs = [...new Set(episodesRaw.map(ep => ep.animeSlug).filter(Boolean))];
    const animeImages = await Anime.find({ pageSlug: { $in: animeSlugs } }).select('pageSlug imageUrl').lean();
    const imageMap = {};
    animeImages.forEach(a => { imageMap[a.pageSlug] = a.imageUrl; });

    const formattedEpisodes = episodesRaw.map(ep => ({
      title: ep.title,
      watchUrl: `/watch${ep.episodeSlug}`,
      imageUrl: imageMap[ep.animeSlug] || ep.animeImageUrl || '/images/default.jpg',
      animeTitle: ep.animeTitle,
      releasedAt: ep.updatedAt || ep.createdAt,
      quality: ep.quality || 'HD',
      year: new Date(ep.updatedAt || ep.createdAt).getFullYear()
    }));

    res.status(200).json({
      success: true,
      data: formattedEpisodes,
      pagination: { currentPage: page, totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE) }
    });

  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

module.exports = router;