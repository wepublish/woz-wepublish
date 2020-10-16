#!/usr/bin/env node
import express from 'express'

async function asyncMain() {
    const app = express()

    app.all('/*', (req, res) => {
        return res.redirect(301,'https://woz.ch')
    })

    const port = process.env.PORT ? parseInt(process.env.PORT) : 5000
    const address = process.env.ADDRESS || 'localhost'

    app.listen(port, address)
}

asyncMain().catch(err => {
    console.error(err)
    process.exit(1)
})
