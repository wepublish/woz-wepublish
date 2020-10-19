#!/usr/bin/env node
import express from 'express'
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN && process.env.RELEASE_VERSION && process.env.RELEASE_ENVIRONMENT) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        release: process.env.RELEASE_VERSION,
        environment: process.env.RELEASE_ENVIRONMENT
    });
} else {
    console.warn('Could not init Sentry')
}

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
    Sentry.captureException(err)
    console.warn('Error during startup', err)
    setTimeout(() => {
        process.exit(0)
    }, 5000)
})
