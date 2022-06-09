const fs = require('fs')
const {spawn, exec} = require('child_process')
try {
    require('dotenv').config()
} catch (e) {}

const {GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_REF, PROJECT_ID} = process.env

let ENVIRONMENT_NAME = 'development'
if (GITHUB_REF === 'refs/heads/main' || GITHUB_REF === 'main') {
    ENVIRONMENT_NAME = 'production'
}
const NAMESPACE = envSwitch(ENVIRONMENT_NAME,'woz', 'woz-dev')

const domain = 'woz.wepublish.media'
const devDomain = 'woz.dev.wepublish.media'
const domainCn = envSwitch(ENVIRONMENT_NAME, `${domain}`, `${devDomain}`)
const domainSan = envSwitch(
    ENVIRONMENT_NAME,
    `www.${domain}`,
    `www.${devDomain}`
)


const domainMedia = envSwitch(ENVIRONMENT_NAME, `media.${domain}`, `media.${devDomain}`)
const domainAPI = envSwitch(ENVIRONMENT_NAME, `api.${domain}`, `api.${devDomain}`)
const domainEditor = envSwitch(ENVIRONMENT_NAME, `editor.${domain}`, `editor.${devDomain}`)
const domainOauth = envSwitch(ENVIRONMENT_NAME, `login.${domain}`, `login.${devDomain}`)


main().catch(e => {
    process.stderr.write(e.toString())
    process.exit(1)
})

async function main() {
    await applyNamespace()
    //await applyWebsite()
    await applyMediaServer()
    await applyApiServer()
    await applyEditor()
    //await applyOAuth2()
    await applyMongo()
}

async function applyNamespace() {
    let namespace = {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
            name: NAMESPACE,
            labels: {
                name: NAMESPACE
            }
        }
    }
    await applyConfig('namespace', namespace)
}

async function applyWebsite() {
    const servicePort = 5000
    const app = 'website'
    const appName = `${app}-${ENVIRONMENT_NAME}`

    const service = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
            name: appName,
            namespace: NAMESPACE
        },
        spec: {
            ports: [
                {
                    name: 'http',
                    port: servicePort,
                    protocol: 'TCP',
                    targetPort: servicePort
                }
            ],
            selector: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            sessionAffinity: 'None',
            type: 'ClusterIP'
        }
    }
    await applyConfig(`service-${app}`, service)

    function getRule(host) {
        return {
            host: host,
            http: {
                paths: [
                    {
                        backend: {
                            serviceName: appName,
                            servicePort: servicePort
                        },
                        path: '/'
                    }
                ]
            }
        }
    }

    let rules = [getRule(domainCn)]
    let hosts = [domainCn]
    if (domainSan) {
        const domains = domainSan.split(',')
        // rules = rules.concat(domains.map(domain => getRule(domain)))
        hosts = hosts.concat(domains)
    }

    let ingress = {
        apiVersion: 'networking.k8s.io/v1beta1',
        kind: 'Ingress',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            annotations: {
                'kubernetes.io/ingress.class': 'nginx',
                'nginx.ingress.kubernetes.io/from-to-www-redirect': 'true',
                'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
                'nginx.ingress.kubernetes.io/proxy-body-size': '1m',
                'nginx.ingress.kubernetes.io/proxy-read-timeout': '30',
                'cert-manager.io/cluster-issuer': 'letsencrypt-production'
            }
        },
        spec: {
            rules: rules,
            tls: [
                {
                    hosts: hosts,
                    secretName: `${appName}-woz-tls`
                }
            ]
        }
    }

    if (ENVIRONMENT_NAME !== 'production') {
        ingress.metadata.annotations['nginx.ingress.kubernetes.io/auth-type'] = 'basic'
        ingress.metadata.annotations['nginx.ingress.kubernetes.io/auth-secret'] = 'basic-auth'
        ingress.metadata.annotations['nginx.ingress.kubernetes.io/auth-realm'] =
            'Authentication Required'
    }

    await applyConfig(`ingress-${app}`, ingress)

    // Info Resources: https://github.com/kubernetes/community/blob/master/contributors/design-proposals/node/resource-qos.md
    const deployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            }
        },
        spec: {
            replicas: 1,
            selector: {
                matchLabels: {
                    app: app,
                    release: ENVIRONMENT_NAME
                }
            },
            strategy: {
                rollingUpdate: {
                    maxSurge: 1,
                    maxUnavailable: 0
                },
                type: 'RollingUpdate'
            },
            template: {
                metadata: {
                    name: appName,
                    labels: {
                        app: app,
                        release: ENVIRONMENT_NAME
                    }
                },
                spec: {
                    containers: [
                        {
                            name: appName,
                            image: `eu.gcr.io/${PROJECT_ID}/${GITHUB_REPOSITORY}/website:${GITHUB_SHA}`,
                            env: [
                                {
                                    name: 'NODE_ENV',
                                    value: `production`
                                },
                                {
                                    name: 'HOST_ENV',
                                    value: envSwitch(ENVIRONMENT_NAME, 'production', 'development')
                                },
                                {
                                    name: 'CANONICAL_HOST',
                                    value: envSwitch(
                                        ENVIRONMENT_NAME,
                                        `https://${domain}`,
                                        `https://${devDomain}`
                                    )
                                },
                                {
                                    name: 'API_URL',
                                    value: `https://${domainAPI}`
                                },
                                {
                                    name: 'ALLOWED_HOSTS',
                                    value: `${domainCn},${domainSan}`
                                }
                            ],
                            ports: [
                                {
                                    containerPort: servicePort,
                                    protocol: 'TCP'
                                }
                            ],
                            imagePullPolicy: 'IfNotPresent',
                            resources: {
                                requests: {
                                    cpu: '0m',
                                    memory: envSwitch(ENVIRONMENT_NAME, '128Mi', '128Mi')
                                }
                            },
                            readinessProbe: {
                                httpGet: {
                                    httpHeaders: [
                                        {
                                            name: 'Host',
                                            value: domainCn
                                        }
                                    ],
                                    path: '/',
                                    port: servicePort,
                                    scheme: 'HTTP'
                                },
                                initialDelaySeconds: 5,
                                successThreshold: 1,
                                timeoutSeconds: 60
                            },
                            livenessProbe: {
                                httpGet: {
                                    httpHeaders: [
                                        {
                                            name: 'Host',
                                            value: domainCn
                                        }
                                    ],
                                    path: '/',
                                    port: servicePort,
                                    scheme: 'HTTP'
                                },
                                initialDelaySeconds: 60,
                                periodSeconds: 60,
                                successThreshold: 1,
                                timeoutSeconds: 60
                            }
                        }
                    ]
                }
            }
        }
    }
    await applyConfig(`deployment-${app}`, deployment)
}

async function applyMediaServer() {
    const app = 'media'
    const appName = `${app}-${ENVIRONMENT_NAME}`
    const appPort = 4001

    const pvc = {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
            name: 'woz-media',
            namespace: NAMESPACE
        },
        spec: {
            accessModes: ["ReadWriteOnce"],
            resources: {
                requests: {
                    storage: "30Gi"
                }
            }
        }
    }

    await applyConfig(`pvc-${app}`, pvc)

    const deployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            }
        },
        spec: {
            replicas: 1,
            selector: {
                matchLabels: {
                    app: app,
                    release: ENVIRONMENT_NAME
                }
            },
            strategy: {
                type: 'Recreate'
            },
            template: {
                metadata: {
                    name: appName,
                    labels: {
                        app: app,
                        release: ENVIRONMENT_NAME
                    }
                },
                spec: {
                    containers: [
                        {
                            name: appName,
                            image: `eu.gcr.io/${PROJECT_ID}/${GITHUB_REPOSITORY}/media:${GITHUB_SHA}`,
                            env: [
                                {
                                    name: 'NODE_ENV',
                                    value: `production`
                                },
                                {
                                    name: 'STORAGE_PATH',
                                    value: '/home/node/.media'
                                },
                                {
                                    name: 'NUM_CLUSTERS',
                                    value: '1'
                                },
                                {
                                    name: 'TOKEN',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'woz-secrets',
                                            key: 'media_server_token'
                                        }
                                    }
                                }
                            ],
                            ports: [
                                {
                                    containerPort: appPort,
                                    protocol: 'TCP'
                                }
                            ],
                            imagePullPolicy: 'IfNotPresent',
                            resources: {
                                requests: {
                                    cpu: '0m',
                                    memory: '128Mi'
                                }
                            },
                            terminationMessagePath: '/dev/termination-log',
                            terminationMessagePolicy: 'File',
                            volumeMounts: [
                                {
                                    name: 'media-volume',
                                    mountPath: '/home/node/.media'
                                }
                            ]
                        }
                    ],
                    dnsPolicy: 'ClusterFirst',
                    restartPolicy: 'Always',
                    schedulerName: 'default-scheduler',
                    terminationGracePeriodSeconds: 30,
                    securityContext: {
                        fsGroup: 1000
                    },
                    volumes: [
                        {
                            name: 'media-volume',
                            persistentVolumeClaim: {
                                claimName: 'woz-media'
                            }
                        }
                    ]
                }
            }
        }
    }
    await applyConfig(`deployment-${app}`, deployment)

    const service = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
            name: appName,
            namespace: NAMESPACE
        },
        spec: {
            ports: [
                {
                    name: 'http',
                    port: appPort,
                    protocol: 'TCP',
                    targetPort: appPort
                }
            ],
            selector: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            type: 'ClusterIP'
        }
    }
    await applyConfig(`service-${app}`, service)

    let ingress = {
        apiVersion: 'networking.k8s.io/v1beta1',
        kind: 'Ingress',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            annotations: {
                'kubernetes.io/ingress.class': 'nginx',
                'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
                'nginx.ingress.kubernetes.io/proxy-body-size': '20m',
                'nginx.ingress.kubernetes.io/proxy-read-timeout': '30',
                'cert-manager.io/cluster-issuer': 'letsencrypt-production'
            }
        },
        spec: {
            rules: [
                {
                    host: domainMedia,
                    http: {
                        paths: [
                            {
                                backend: {
                                    serviceName: appName,
                                    servicePort: appPort
                                },
                                path: '/'
                            }
                        ]
                    }
                }
            ],
            tls: [
                {
                    hosts: [domainMedia],
                    secretName: `${appName}-woz-tls`
                }
            ]
        }
    }
    await applyConfig(`ingress-${app}`, ingress)
}

async function applyApiServer() {
    const app = 'api'
    const appName = `${app}-${ENVIRONMENT_NAME}`
    const appPort = 4000

    const deployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            }
        },
        spec: {
            replicas: 1,
            selector: {
                matchLabels: {
                    app: app,
                    release: ENVIRONMENT_NAME
                }
            },
            strategy: {
                rollingUpdate: {
                    maxSurge: 1,
                    maxUnavailable: 0
                },
                type: 'RollingUpdate'
            },
            template: {
                metadata: {
                    name: appName,
                    labels: {
                        app: app,
                        release: ENVIRONMENT_NAME
                    }
                },
                spec: {
                    volumes: [
                        {
                            name: 'google-cloud-key',
                            secret: {
                                secretName: 'log-the-things'
                            }
                        }
                    ],
                    containers: [
                        {
                            name: appName,
                            image: `eu.gcr.io/${PROJECT_ID}/${GITHUB_REPOSITORY}/api:${GITHUB_SHA}`,
                            volumeMounts: [
                                {
                                    "name": "google-cloud-key",
                                    "mountPath": "/var/secrets/google"
                                }
                            ],
                            env: [
                                {
                                    name: 'NODE_ENV',
                                    value: `production`
                                },
                                {
                                    name: "GOOGLE_APPLICATION_CREDENTIALS",
                                    value: "/var/secrets/google/key.json"
                                },
                                {
                                    name: 'MEDIA_SERVER_URL',
                                    value: `https://${domainMedia}`
                                },
                                {
                                    name: 'MEDIA_ADDRESS',
                                    value: `${domainMedia}`
                                },
                                {
                                    name: 'MEDIA_PORT',
                                    value: '443'
                                },
                                {
                                    name: 'MONGO_URL',
                                    value: envSwitch(
                                        ENVIRONMENT_NAME,
                                        'mongodb://mongo-production:27017/woz',
                                        'mongodb://mongo-development:27017/woz'
                                    )
                                },
                                {
                                    name: 'MONGO_LOCALE',
                                    value: 'de'
                                },

                                {
                                    name: 'HOST_URL',
                                    value: `https://${domainAPI}`,
                                },
                                {
                                    name: 'WEBSITE_URL',
                                    value: envSwitch(
                                        ENVIRONMENT_NAME,
                                        `https://${domain}`,
                                        `https://${devDomain}`
                                    )
                                },
                                {
                                    name: 'MEDIA_SERVER_TOKEN',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'woz-secrets',
                                            key: 'media_server_token'
                                        }
                                    }
                                },
                                {
                                    name: 'JWT_SECRET_KEY',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'woz-secrets',
                                            key: 'jwt_secret_key'
                                        }
                                    }
                                },{
                                    name: 'SENTRY_DSN',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'woz-secrets',
                                            key: 'sentry_dsn'
                                        }
                                    }
                                },
                                {
                                    name: 'SENTRY_ENV',
                                    value: envSwitch(ENVIRONMENT_NAME, 'production', 'staging')
                                },{
                                    name: 'GOOGLE_PROJECT',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'woz-secrets',
                                            key: 'google_project'
                                        }
                                    }
                                }
                            ],
                            ports: [
                                {
                                    containerPort: appPort,
                                    protocol: 'TCP'
                                }
                            ],
                            imagePullPolicy: 'IfNotPresent',
                            resources: {
                                requests: {
                                    cpu: '0m',
                                    memory: '128Mi'
                                }
                            },
                            terminationMessagePath: '/dev/termination-log',
                            terminationMessagePolicy: 'File'
                        }
                    ]
                }
            }
        }
    }
    await applyConfig(`deployment-${app}`, deployment)

    const service = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
            name: appName,
            namespace: NAMESPACE
        },
        spec: {
            ports: [
                {
                    name: 'http',
                    port: appPort,
                    protocol: 'TCP',
                    targetPort: appPort
                }
            ],
            selector: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            type: 'ClusterIP'
        }
    }
    await applyConfig(`service-${app}`, service)

    let ingress = {
        apiVersion: 'networking.k8s.io/v1beta1',
        kind: 'Ingress',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            annotations: {
                'kubernetes.io/ingress.class': 'nginx',
                'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
                'nginx.ingress.kubernetes.io/proxy-body-size': '10m',
                'nginx.ingress.kubernetes.io/proxy-read-timeout': '30',
                'cert-manager.io/cluster-issuer': 'letsencrypt-production'
            }
        },
        spec: {
            rules: [
                {
                    host: domainAPI,
                    http: {
                        paths: [
                            {
                                backend: {
                                    serviceName: appName,
                                    servicePort: appPort
                                },
                                path: '/'
                            }
                        ]
                    }
                }
            ],
            tls: [
                {
                    hosts: [domainAPI],
                    secretName: `${appName}-woz-tls`
                }
            ]
        }
    }
    await applyConfig(`ingress-${app}`, ingress)
}

async function applyEditor() {
    const app = 'editor'
    const appName = `${app}-${ENVIRONMENT_NAME}`
    const appPort = 3000

    const deployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            }
        },
        spec: {
            replicas: 1,
            selector: {
                matchLabels: {
                    app: app,
                    release: ENVIRONMENT_NAME
                }
            },
            strategy: {
                rollingUpdate: {
                    maxSurge: 1,
                    maxUnavailable: 0
                },
                type: 'RollingUpdate'
            },
            template: {
                metadata: {
                    name: appName,
                    labels: {
                        app: app,
                        release: ENVIRONMENT_NAME
                    }
                },
                spec: {
                    containers: [
                        {
                            name: appName,
                            image: `eu.gcr.io/${PROJECT_ID}/${GITHUB_REPOSITORY}/editor:${GITHUB_SHA}`,
                            env: [
                                {
                                    name: 'NODE_ENV',
                                    value: `production`
                                },
                                {
                                    name: 'API_URL',
                                    value: `https://${domainAPI}`
                                },
                                {
                                    name: 'PEER_BY_DEFAULT',
                                    value: 'true'
                                }
                            ],
                            ports: [
                                {
                                    containerPort: appPort,
                                    protocol: 'TCP'
                                }
                            ],
                            imagePullPolicy: 'IfNotPresent',
                            resources: {
                                requests: {
                                    cpu: '0m',
                                    memory: '128Mi'
                                }
                            },
                            terminationMessagePath: '/dev/termination-log',
                            terminationMessagePolicy: 'File'
                        }
                    ],
                    dnsPolicy: 'ClusterFirst',
                    restartPolicy: 'Always',
                    schedulerName: 'default-scheduler',
                    terminationGracePeriodSeconds: 30
                }
            }
        }
    }
    await applyConfig(`deployment-${app}`, deployment)

    const service = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
            name: appName,
            namespace: NAMESPACE
        },
        spec: {
            ports: [
                {
                    name: 'http',
                    port: appPort,
                    protocol: 'TCP',
                    targetPort: appPort
                }
            ],
            selector: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            type: 'ClusterIP'
        }
    }
    await applyConfig(`service-${app}`, service)

    let ingress = {
        apiVersion: 'networking.k8s.io/v1beta1',
        kind: 'Ingress',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            annotations: {
                'kubernetes.io/ingress.class': 'nginx',
                'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
                'nginx.ingress.kubernetes.io/proxy-body-size': '20m',
                'nginx.ingress.kubernetes.io/proxy-read-timeout': '30',
                'cert-manager.io/cluster-issuer': 'letsencrypt-production'
            }
        },
        spec: {
            rules: [
                {
                    host: domainEditor,
                    http: {
                        paths: [
                            {
                                backend: {
                                    serviceName: appName,
                                    servicePort: appPort
                                },
                                path: '/'
                            }
                        ]
                    }
                }
            ],
            tls: [
                {
                    hosts: [domainEditor],
                    secretName: `${appName}-woz-tls`
                }
            ]
        }
    }
    await applyConfig(`ingress-${app}`, ingress)
}

async function applyOAuth2() {
    const app = 'oauth2'
    const appName = `${app}-${ENVIRONMENT_NAME}`
    const appPort = 8000

    const deployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            }
        },
        spec: {
            replicas: 1,
            selector: {
                matchLabels: {
                    app: app,
                    release: ENVIRONMENT_NAME
                }
            },
            strategy: {
                rollingUpdate: {
                    maxSurge: 1,
                    maxUnavailable: 0
                },
                type: 'RollingUpdate'
            },
            template: {
                metadata: {
                    name: appName,
                    labels: {
                        app: app,
                        release: ENVIRONMENT_NAME
                    }
                },
                spec: {
                    containers: [
                        {
                            name: appName,
                            image: `${CI_REGISTRY_IMAGE}/oauth2:${CI_COMMIT_SHORT_SHA}`,
                            env: [
                                {
                                    name: 'NODE_ENV',
                                    value: `production`
                                },
                                {
                                    name: 'MONGO_URL',
                                    value: envSwitch(ENVIRONMENT_NAME,
                                        `mongodb://mongo-production:27017/tsri`,
                                        `mongodb://mongo-development:27017/tsri`
                                    )
                                },
                                {
                                    name: 'OAUTH_MONGODB_URI',
                                    value: envSwitch(ENVIRONMENT_NAME,
                                        `mongodb://mongo-production:27017/tsri-oauth2`,
                                        `mongodb://mongo-development:27017/tsri-oauth2`
                                    )
                                },
                                {
                                    name: 'OAUTH_CLIENT_ID',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'wepublish-oauth-secrets',
                                            key: 'oauth_client_id'
                                        }
                                    }
                                },
                                {
                                    name: 'OAUTH_CLIENT_SECRET',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'wepublish-oauth-secrets',
                                            key: 'oauth_client_secret'
                                        }
                                    }
                                },
                                {
                                    name: 'OAUTH_GRANT_TYPES',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'wepublish-oauth-secrets',
                                            key: 'oauth_grant_types'
                                        }
                                    }
                                },
                                {
                                    name: 'OAUTH_REDIRECT_URIS',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'wepublish-oauth-secrets',
                                            key: 'oauth_redirect_uris'
                                        }
                                    }
                                },
                                {
                                    name: 'OAUTH_COOKIE_KEYS',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'wepublish-oauth-secrets',
                                            key: 'oauth_cookie_keys'
                                        }
                                    }
                                },
                                {
                                    name: 'JWKS_KEYS',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: 'wepublish-oauth-secrets',
                                            key: 'jwks_keys'
                                        }
                                    }
                                }
                            ],
                            ports: [
                                {
                                    containerPort: appPort,
                                    protocol: 'TCP'
                                }
                            ],
                            imagePullPolicy: 'IfNotPresent',
                            resources: {
                                requests: {
                                    cpu: '0m',
                                    memory: '128Mi'
                                }
                            },
                            terminationMessagePath: '/dev/termination-log',
                            terminationMessagePolicy: 'File'
                        }
                    ],
                    dnsPolicy: 'ClusterFirst',
                    restartPolicy: 'Always',
                    schedulerName: 'default-scheduler',
                    terminationGracePeriodSeconds: 30
                }
            }
        }
    }
    await applyConfig(`deployment-${app}`, deployment)

    const service = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
            name: appName,
            namespace: NAMESPACE
        },
        spec: {
            ports: [
                {
                    name: 'http',
                    port: appPort,
                    protocol: 'TCP',
                    targetPort: appPort
                }
            ],
            selector: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            type: 'ClusterIP'
        }
    }
    await applyConfig(`service-${app}`, service)

    let ingress = {
        apiVersion: 'networking.k8s.io/v1beta1',
        kind: 'Ingress',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            annotations: {
                'kubernetes.io/ingress.class': 'nginx',
                'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
                'nginx.ingress.kubernetes.io/proxy-body-size': '20m',
                'nginx.ingress.kubernetes.io/proxy-read-timeout': '30',
                'cert-manager.io/cluster-issuer': 'letsencrypt-production'
            }
        },
        spec: {
            rules: [
                {
                    host: domainOauth,
                    http: {
                        paths: [
                            {
                                backend: {
                                    serviceName: appName,
                                    servicePort: appPort
                                },
                                path: '/'
                            }
                        ]
                    }
                }
            ],
            tls: [
                {
                    hosts: [domainOauth],
                    secretName: `${appName}-woz-tls`
                }
            ]
        }
    }
    await applyConfig(`ingress-${app}`, ingress)
}

async function applyMongo() {
    const app = 'mongo'
    const port = 27017
    const appName = `${app}-${ENVIRONMENT_NAME}`

    const pvc = {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
            name: envSwitch(
                ENVIRONMENT_NAME,
                'wepublish-mongo',
                `wepublish-mongo`
            ),
            namespace: NAMESPACE
        },
        spec: {
            accessModes: ["ReadWriteOnce"],
            resources: {
                requests: {
                    storage: envSwitch(ENVIRONMENT_NAME, "30Gi", "10Gi")
                }
            }
        }
    }

    await applyConfig(`pvc-${app}`, pvc)

    const deployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
            name: appName,
            namespace: NAMESPACE,
            labels: {
                app: app,
                release: ENVIRONMENT_NAME
            }
        },
        spec: {
            replicas: 1,
            selector: {
                matchLabels: {
                    app: app,
                    release: ENVIRONMENT_NAME
                }
            },
            strategy: {
                type: 'Recreate'
            },
            template: {
                metadata: {
                    name: appName,
                    labels: {
                        app: app,
                        release: ENVIRONMENT_NAME
                    }
                },
                spec: {
                    containers: [
                        {
                            name: appName,
                            image: 'mongo:4.2.3-bionic',
                            env: [],
                            ports: [
                                {
                                    containerPort: port,
                                    protocol: 'TCP'
                                }
                            ],
                            imagePullPolicy: 'IfNotPresent',
                            resources: {
                                requests: {
                                    cpu: '0m',
                                    memory: '128Mi'
                                }
                            },
                            terminationMessagePath: '/dev/termination-log',
                            terminationMessagePolicy: 'File',
                            volumeMounts: [
                                {
                                    name: 'mongo-volume',
                                    mountPath: '/data/db'
                                }
                            ]
                        }
                    ],
                    dnsPolicy: 'ClusterFirst',
                    restartPolicy: 'Always',
                    schedulerName: 'default-scheduler',
                    terminationGracePeriodSeconds: 30,
                    volumes: [
                        {
                            name: 'mongo-volume',
                            persistentVolumeClaim: {
                                claimName: envSwitch(
                                    ENVIRONMENT_NAME,
                                    'wepublish-mongo',
                                    `wepublish-mongo`
                                ),
                            }
                        }
                    ]
                }
            }
        }
    }
    await applyConfig(`deployment-${app}`, deployment)

    const service = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
            name: appName,
            namespace: NAMESPACE
        },
        spec: {
            ports: [
                {
                    name: 'http',
                    port: port,
                    protocol: 'TCP',
                    targetPort: port
                }
            ],
            selector: {
                app: app,
                release: ENVIRONMENT_NAME
            },
            type: 'ClusterIP'
        }
    }
    await applyConfig(`service-${app}`, service)
}

async function applyConfig(name, obj) {
    const configPath = 'kubernetesConfigs'
    try {
        await execCommand(`mkdir ${configPath}`)
    } catch (e) {}
    const filename = `./${configPath}/${name}.json`
    await writeFile(filename, obj)
}

function writeFile(filePath, json) {
    return new Promise(function (resolve, reject) {
        fs.writeFile(filePath, JSON.stringify(json, null, 2), function (error) {
            if (error) {
                return reject(error)
            } else {
                resolve(true)
            }
        })
    })
}

function execCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, function (error, stdout, stderr) {
            if (error) {
                reject(error)
            } else {
                resolve(stdout)
            }
        })
    })
}

function envSwitch(env, prod, staging) {
    return env === 'production' ? prod : staging
}
