import {MongoDBAdapter} from "@wepublish/api-db-mongodb";
import axios from 'axios'
import {KarmaMediaAdapter} from "@wepublish/api-media-karma/lib";
import {URL} from "url";
import {ArrayBufferUpload, ArticleInput} from "@wepublish/api";
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN && process.env.RELEASE_VERSION && process.env.ENVIRONMENT_NAME) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        release: process.env.RELEASE_VERSION,
        environment: process.env.ENVIRONMENT_NAME
    });
} else {
    console.warn('Could not init Sentry')
}

const FETCH_LIMIT = 10
const FETCH_URL = 'https://www.woz.ch/wepub/1.0/articles'


export interface WozTeaser {
    url: string
    id: string
    title: string
    publishedAt: Date
    updatedAt: Date
    update: boolean
    updateID: string
}

export interface WozAuthor {
    id: string
    createdAt: Date
    modifiedAt: Date
    name: string
    slug: string
    links: []
    bio: []
}

export interface WozImage {
    type: string
    id: string
    url: string
    width: number
    height: number
    mimeType: string
}

export interface WozArticle {
    id: string
    shared: boolean
    publishedAt: Date
    updatedAt: Date
    preTitle: string
    title: string
    lead: string
    slug: string
    tags: string[]
    authorIDs: string[]
    authorRecords: WozAuthor[]
    breaking: boolean
    blocks: any[]
    imageID: string
    imageRecord: WozImage
    permalink: string
}

const asyncFilter = async (arr: [], predicate: any) => {
    const results = await Promise.all(arr.map(predicate));

    return arr.filter((_v, index) => results[index]);
}

async function asyncMain() {

    if (!process.env.MONGO_URL) throw new Error('No MONGO_URL defined in environment.')
    if (!process.env.HOST_URL) throw new Error('No HOST_URL defined in environment.')

    if (!process.env.MEDIA_SERVER_URL) {
        throw new Error('No MEDIA_SERVER_URL defined in environment.')
    }

    if (!process.env.MEDIA_SERVER_TOKEN) {
        throw new Error('No MEDIA_SERVER_TOKEN defined in environment.')
    }

    const dbAdapter = await MongoDBAdapter.connect({
        url: process.env.MONGO_URL!,
        locale: process.env.MONGO_LOCALE ?? 'en'
    })

    const mediaAdapter = new KarmaMediaAdapter(
        new URL(process.env.MEDIA_SERVER_URL),
        process.env.MEDIA_SERVER_TOKEN
    )

    let hasMore = true
    let offset = 0

    const articlesToFetch: WozTeaser[] = []

    while(hasMore) {
        try {
            const result = await axios.get(`${FETCH_URL}?offset=${offset}&limit=${FETCH_LIMIT}`, {
                method: 'GET',
                headers: {

                    'Content-Type': 'application/json'
                }
            })

            if(result.status === 200) {
                const wozTeasers: WozTeaser[] = await Promise.all(result.data.map(async (wozTeaser: WozTeaser) => {
                    const existingArticle = await dbAdapter.db.collection('articles').findOne({'published.properties.key': 'wozID', 'published.properties.value': wozTeaser.id})
                    return {
                        ...wozTeaser,
                        update: existingArticle === null || new Date(wozTeaser.updatedAt) > new Date(existingArticle.modifiedAt),
                        updateID: existingArticle === null ? '' : existingArticle._id
                    }
                }))
                articlesToFetch.push(...wozTeasers)
                offset += FETCH_LIMIT
            } else {
                hasMore = false
            }

        } catch(error) {
            if(error.response.status === 404) {
                Sentry.captureException(error)
            }
            hasMore = false
        }
    }

    for(const article of articlesToFetch) {
        try {
            if(!article.update) {
                continue
            }
            const result = await axios.get(article.url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            })
            console.log(`Fetched Article: ${article.title}`)
            const wozArticle: WozArticle = result.data


            // Create authors if they are new
            if(wozArticle?.authorRecords) {
                const authorIDs: string[] = []
                for(const author of wozArticle.authorRecords) {
                    const results = await dbAdapter.author.getAuthorsBySlug([author.slug])
                    if(results[0] === null) {
                        const createdAuthor = await dbAdapter.author.createAuthor({
                            input: {
                                name: author.name,
                                slug: author.slug,
                                links: [],
                                bio: []
                            }
                        })
                        console.log(`Created author: ${createdAuthor.name}`)
                        authorIDs.push(createdAuthor.id)
                    }
                }
                wozArticle.authorIDs = authorIDs
            }

            if(wozArticle?.imageRecord) {

                const result = await axios.get(wozArticle.imageRecord.url, {
                    responseType: 'arraybuffer'
                })

                const arrayBufferPromise = new Promise<ArrayBufferUpload>((resolve, rejects) => {
                    resolve({
                        arrayBuffer: result.data,
                        filename: wozArticle.imageRecord.id,
                        mimetype: wozArticle.imageRecord.mimeType
                    })
                })

                const {id, ...image} = await mediaAdapter.uploadImageFromArrayBuffer(arrayBufferPromise)

                const wepImage = await dbAdapter.image.createImage({
                    id,
                    input: {
                        ...image,

                        filename: image.filename,
                        title: `${wozArticle.title} - Mood Image`,
                        description: '',
                        tags: []
                    }
                })
                if(!wepImage) {
                    throw new Error('wepImage is null or undefined')
                }
                wozArticle.imageID = wepImage.id
            }
            const input : ArticleInput = {
                title: wozArticle.title,
                slug: wozArticle.slug,
                shared: true,
                tags: [...wozArticle.tags],
                breaking: wozArticle.breaking,
                preTitle: wozArticle.preTitle,
                lead: wozArticle.lead,
                blocks: wozArticle.blocks,
                authorIDs: wozArticle.authorIDs,
                properties: [{
                    key: "wozID",
                    value: wozArticle.id,
                    public: false
                },{
                    key: "wozLink",
                    value: wozArticle.permalink,
                    public: true
                }],
                imageID: wozArticle.imageID
            }
            const upsertArticle = article.updateID === '' ? await dbAdapter.article.createArticle({input}) : await dbAdapter.article.updateArticle({id: article.updateID, input})
            if(upsertArticle !== null) {
                await dbAdapter.article.publishArticle({id: upsertArticle.id, publishAt: new Date(), publishedAt: new Date(), updatedAt: new Date()})
            } else {
                throw new Error(`Updating Article with ID: ${article.updateID} failed`)
            }


        } catch(error) {
            console.log(`Article Fetch with ID: ${article.id} failed`, error)
        }
    }
}

asyncMain().catch(err => {
    Sentry.captureException(err)
    console.warn('Error during startup', err)
}).finally(() => {
    setTimeout(() => {
        process.exit(0)
    }, 5000)
})

