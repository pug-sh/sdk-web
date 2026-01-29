const express = require('express')
const path = require('path')
const app = express()
const PORT = 8080

// Serve static files from the root directory
app.use(express.static('.'))

// Handle manual_test.html specifically
app.get('/manual_test.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'manual_test.html'))
})

console.log(`Server running at http://localhost:${PORT}/`)
app.listen(PORT)
