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

import {URL} from 'url'

class WozURLAdapter implements URLAdapter {
    getPublicArticleURL(article: PublicArticle): string {
        return `https://demo.wepublish.ch/article/${article.id}/${article.slug}`
    }

    getPublicPageURL(page: PublicPage): string {
        // TODO: should never be called
        return `https://demo.wepublish.ch/page/${page.id}/${page.slug}`
    }

    getAuthorURL(author: Author): string {
        // TODO: fix that
        return `https://demo.wepublish.ch/author/${author.slug || author.id}`
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
                    roleIDs: [adminUserRoleId]
                },
                password: '123'
            })

        }
    })

    const dbAdapter = await MongoDBAdapter.connect({
        url: process.env.MONGO_URL!,
        locale: process.env.MONGO_LOCALE ?? 'en'
    })

    const server = new WepublishServer({
        hostURL,
        websiteURL,
        mediaAdapter,
        dbAdapter,
        oauth2Providers: [],
        urlAdapter: new WozURLAdapter(),
        playground: true,
        introspection: true,
        tracing: true
    })

    await server.listen(port, address)
}

asyncMain().catch(err => {
    console.error(err)
    process.exit(1)
})
