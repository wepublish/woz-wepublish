import {MongoDBAdapter} from "@wepublish/api-db-mongodb";
import axios from 'axios'
import {KarmaMediaAdapter} from "@wepublish/api-media-karma/lib";
import {URL} from "url";
import {ArrayBufferUpload, ArticleInput, DBAdapter, MediaAdapter} from "@wepublish/api";
import * as Sentry from "@sentry/node"

if (process.env.SENTRY_DSN && process.env.RELEASE_VERSION && process.env.RELEASE_ENVIRONMENT) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        release: process.env.RELEASE_VERSION,
        environment: process.env.RELEASE_ENVIRONMENT
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

async function saveImagetoMediaServer(title: string, imageRecord: WozImage, mediaAdapter: MediaAdapter, dbAdapter: DBAdapter): Promise<string> {
    const result = await axios.get(imageRecord.url, {
        responseType: 'arraybuffer'
    })

    const arrayBufferPromise = new Promise<ArrayBufferUpload>((resolve, rejects) => {
        resolve({
            arrayBuffer: result.data,
            filename: imageRecord.id,
            mimetype: imageRecord.mimeType
        })
    })

    const {id, ...image} = await mediaAdapter.uploadImageFromArrayBuffer(arrayBufferPromise)

    const wepImage = await dbAdapter.image.createImage({
        id,
        input: {
            ...image,

            filename: image.filename,
            title,
            description: '',
            tags: []
        }
    })

    if(!wepImage) {
        throw new Error('wepImage is null or undefined')
    }

    return wepImage.id
}

async function asyncMain() {

    if (!process.env.MONGO_URL) throw new Error('No MONGO_URL defined in environment.')
    if (!process.env.HOST_URL) throw new Error('No HOST_URL defined in environment.')
    const FORCE_UPDATE = process.env.FORCE_UPDATE == 'true'

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
                        update: existingArticle === null || new Date(wozTeaser.updatedAt) > new Date(existingArticle.modifiedAt) || FORCE_UPDATE,
                        updateID: existingArticle === null ? '' : existingArticle._id
                    }
                }))
                articlesToFetch.push(...wozTeasers)
                offset += FETCH_LIMIT
            } else {
                hasMore = false
            }

        } catch(error) {
            if(error.response === undefined || error.response.status !== 404) {
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
                    } else {
                        authorIDs.push(results[0].id)
                    }
                }
                wozArticle.authorIDs = authorIDs
            }

            if(wozArticle?.imageRecord) {
                wozArticle.imageID = await saveImagetoMediaServer(`${wozArticle.title} - Mood Image`, wozArticle.imageRecord, mediaAdapter, dbAdapter)
            }

            wozArticle.blocks = await Promise.all(wozArticle.blocks.map(async (block) => {
                switch(block.type) {
                    case 'image':
                        const wepID = await saveImagetoMediaServer(`${wozArticle.title} - image`, block.imageRecord, mediaAdapter, dbAdapter)
                        return {
                            type: block.type,
                            caption: block.caption,
                            imageID: wepID,
                        }
                    case 'imageGallery':
                        return {
                            type: block.type,
                            images: await Promise.all(block.images.map(async (image: any, index: number) => {
                                return {
                                    imageID: await saveImagetoMediaServer(`${wozArticle.title} - imageGallery`, block.imageRecords[index],mediaAdapter, dbAdapter),
                                    caption: image.caption
                                }
                            }))
                        }
                    default:
                        return block
                }
            }))

            const input : ArticleInput = {
                hideAuthor: false,
                socialMediaAuthorIDs: [],
                title: wozArticle.title,
                slug: wozArticle.slug,
                shared: true,
                //tags: [...wozArticle.tags],
                tags: [],
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

