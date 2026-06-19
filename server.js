// v2 - fixed
require('dotenv').config()
const express = require('express')
const app = express()
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

app.post('/render', async (req, res) => {
  res.json({ success: true, message: 'Job queued' })
})

app.listen(3000, () => {
  console.log('Viralora worker running on port 3000')
})