const mongoose = require('mongoose');

const episodeSchema = new mongoose.Schema({
  episodeSlug: { type: String, unique: true, required: true, index: true }, 
  title: String,
  
  streaming: [{ name: String, url: String }],
  downloads: [{
    quality: String,
    links: [{ host: String, url: String }]
  }],

  animeTitle: String,
  animeSlug: { type: String, index: true },
  animeImageUrl: String,
  thumbnailUrl: String

}, { timestamps: true });

module.exports = mongoose.model('Episode', episodeSchema);