const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path'); // Tambahkan path
const apiRoutes = require('./api');

dotenv.config();
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serving Static Images (PENTING AGAR GAMBAR MUNCUL)
// Gambar diakses via http://localhost:3000/images/namafile.jpg
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// Koneksi Database (Gunakan nama DB yang konsisten)
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/nekopoi_db')
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error(err));

// Routes
app.use('/api', apiRoutes); 

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));