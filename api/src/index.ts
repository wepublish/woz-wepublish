#!/usr/bin/env node
import {
    WepublishServer,
    URLAdapter,
    PublicArticle,
    PublicPage,
    Author, Peer, PublicComment, CommentItemType, AlgebraicCaptchaChallenge
} from '@wepublish/api'

import {KarmaMediaAdapter} from '@wepublish/api-media-karma'
import {MongoDBAdapter} from '@wepublish/api-db-mongodb'

import pinoMultiStream from 'pino-multi-stream'
import pinoStackdriver from 'pino-stackdriver'
import {createWriteStream} from 'pino-sentry'
import {URL} from 'url'
import {MetadataProperty} from "@wepublish/api/src/db/common";
import {PaymentProviderCustomer, UserAddress} from "@wepublish/api/src/db/user";
import path from "path";

interface WOZURLAdapterProps {
    websiteURL: string
}

class WozURLAdapter implements URLAdapter {
    readonly websiteURL: string

    constructor(props: WOZURLAdapterProps) {
        this.websiteURL = props.websiteURL
    }

    getPublicArticleURL(article: PublicArticle): string {
        return `${this.websiteURL}/a/${article.id}/${article.slug}`
    }

    getPeeredArticleURL(peer: Peer, article: PublicArticle): string {
        return `${this.websiteURL}/p/${peer.id}/${article.id}`
    }

    getPublicPageURL(page: PublicPage): string {
        return `${this.websiteURL}/page/${page.id}/${page.slug}`
    }

    getAuthorURL(author: Author): string {
        return `${this.websiteURL}/author/${author.slug || author.id}`
    }

    getCommentURL(item: PublicArticle | PublicPage, comment: PublicComment) {
        if (comment.itemType === CommentItemType.Article) {
            return `${this.websiteURL}/a/${item.id}/${item.slug}#${comment.id}`
        }
        return `${this.websiteURL}/${item.slug}#${comment.id}`
    }

    getArticlePreviewURL(token: string) {
        return `${this.websiteURL}/a/preview/${token}`
    }

    getPagePreviewURL(token: string): string {
        return `${this.websiteURL}/${token}`
    }

    getLoginURL(token: string): string {
        return `${this.websiteURL}/login?jwt=${token}`
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
                    active: true,
                    emailVerifiedAt: null,
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
    const challenge = new AlgebraicCaptchaChallenge('changeMe', 600, {
        width: 200,
        height: 200,
        background: '#ffffff',
        noise: 5,
        minValue: 1,
        maxValue: 10,
        operandAmount: 1,
        operandTypes: ['+', '-'],
        mode: 'formula',
        targetSymbol: '?'
    })


    const server = new WepublishServer({
        paymentProviders: [],
        hostURL,
        websiteURL,
        mediaAdapter,
        dbAdapter,
        logger,
        oauth2Providers: [],
        mailContextOptions: {
            defaultFromAddress: process.env.DEFAULT_FROM_ADDRESS ?? 'dev@wepublish.ch',
            defaultReplyToAddress: process.env.DEFAULT_REPLY_TO_ADDRESS ?? 'reply-to@wepublish.ch',
            mailTemplateMaps: [],
            mailTemplatesPath: path.resolve('templates', 'emails')
        },
        urlAdapter: new WozURLAdapter({websiteURL:"https://woz.ch"}),
        playground: false,
        introspection: true,
        tracing: true,
        challenge
    })

    await server.listen(port, address)
}

asyncMain().catch(err => {
    console.warn('Error during startup', err)
    setTimeout(() => {
        process.exit(0)
    }, 5000)
})
