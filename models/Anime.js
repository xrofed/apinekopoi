const mongoose = require('mongoose');

const animeSchema = new mongoose.Schema({
  title: { type: String, required: true },
  pageSlug: { type: String, unique: true, required: true, index: true },
  imageUrl: { type: String, default: '/images/default.jpg' },
  synopsis: String,
  
  info: {
    Alternatif: { type: String, default: '' },
    Type: { type: String, default: '' },
    Status: { type: String, default: 'Unknown' },
    Produser: { type: String, default: '' },
    Released: { type: String, default: '' },
    Studio: { type: String, default: '' },
    Duration: { type: String, default: '' },
    Censor: { type: String, default: '' }
  },

  genres: [String],
  
  // PERBAIKAN: Menggunakan 'url' agar sesuai dengan query API
  episodes: [{
    url: String,        // ex: /kegareboshi-episode-1
    title: String,      // ex: Kegareboshi Episode 1
    date: String,       // ex: January 2, 2026
    episodeNum: Number
  }],

  viewCount: { type: Number, default: 0, index: true }
}, { timestamps: true });

module.exports = mongoose.model('Anime', animeSchema);