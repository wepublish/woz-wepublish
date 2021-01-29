#!/usr/bin/env node
import {
    WepublishServer,
    URLAdapter,
    PublicArticle,
    PublicPage,
    Author
} from '@wepublish/api'

import {KarmaMediaAdapter} from '@wepublish/api-media-karma'
import {MongoDBAdapter} from '@wepublish/api-db-mongodb'

import pinoMultiStream from 'pino-multi-stream'
import pinoStackdriver from 'pino-stackdriver'
import {createWriteStream} from 'pino-sentry'
import {URL} from 'url'

class WozURLAdapter implements URLAdapter {
    getPublicArticleURL(article: PublicArticle): string {
        const wozLink = article.properties.find((property => property.key === 'wozLink'))
        return wozLink?.value || 'https://www.woz.ch'
    }

    getPublicPageURL(page: PublicPage): string {
        // TODO: should never be called
        return `https://woz.ch`
    }

    getAuthorURL(author: Author): string {
        return `https://woz.ch/archiv/"${author.name}"`
    }
}

async function asyncMain() {
    if (!process.env.MONGO_URL) throw new Error('No MONGO_URL defined in environment.')
    if (!process.env.HOST_URL) throw new Error('No HOST_URL defined in environment.')

    const hostURL = process.env.HOST_URL
    const websiteURL = process.env.WEBSITE_URL ?? 'https://woz.wepublish.media'

    const port = process.env.PORT ? parseInt(process.env.PORT) : undefined
    const address = process.env.ADDRESS ? process.env.ADDRESS : 'localhost'

    if (!process.env.MEDIA_SERVER_URL) {
        throw new Error('No MEDIA_SERVER_URL defined in environment.')
    }

    if (!process.env.MEDIA_SERVER_TOKEN) {
        throw new Error('No MEDIA_SERVER_TOKEN defined in environment.')
    }

    const mediaAdapter = new KarmaMediaAdapter(
        new URL(process.env.MEDIA_SERVER_URL),
        process.env.MEDIA_SERVER_TOKEN
    )

    await MongoDBAdapter.initialize({
        url: process.env.MONGO_URL!,
        locale: process.env.MONGO_LOCALE ?? 'en',
        seed: async adapter => {
            const adminUserRole = await adapter.userRole.getUserRole('Admin')
            const adminUserRoleId = adminUserRole ? adminUserRole.id : 'fake'

            await adapter.user.createUser({
                input: {
                    email: 'dev@wepublish.ch',
                    name: 'Dev User',
                    roleIDs: [adminUserRoleId],
                    properties: [],
                    active: true
                },
                password: '123'
            })

        }
    })

    const dbAdapter = await MongoDBAdapter.connect({
        url: process.env.MONGO_URL!,
        locale: process.env.MONGO_LOCALE ?? 'en'
    })

    const streams: pinoMultiStream.Streams = []

    if (process.env.GOOGLE_PROJECT && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        streams.push({
            level: 'info',
            stream: pinoStackdriver.createWriteStream({
                projectId: process.env.GOOGLE_PROJECT,
                logName: 'wepublish_woz_api'
            })
        })
    }

    if (process.env.SENTRY_DSN && process.env.RELEASE_VERSION && process.env.RELEASE_ENVIRONMENT) {
        streams.push({
            level: 'error',
            stream: createWriteStream({
                dsn: process.env.SENTRY_DSN,
                release: process.env.RELEASE_VERSION,
                environment: process.env.RELEASE_ENVIRONMENT,
            })
        })
    }

    const logger = pinoMultiStream({
        streams,
        level: 'debug'
    })

    const server = new WepublishServer({
        paymentProviders: [],
        hostURL,
        websiteURL,
        mediaAdapter,
        dbAdapter,
        logger,
        oauth2Providers: [],
        urlAdapter: new WozURLAdapter(),
        playground: true,
        introspection: true,
        tracing: true
    })

    await server.listen(port, address)
}

asyncMain().catch(err => {
    console.warn('Error during startup', err)
    setTimeout(() => {
        process.exit(0)
    }, 5000)
})
