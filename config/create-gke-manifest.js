const fs = require('fs')
const {spawn, exec} = require('child_process')
try {
  require('dotenv').config()
} catch (e) {}

let {GITHUB_SHA, GITHUB_REPOSITORY, PROJECT_ID} = process.env

const GOOGLE_REGISTRY_HOST_NAME = 'eu.gcr.io'
const NAMESPACE = 'wepublish-woz'
const ENVIRONMENT_NAME = 'production'

const domain = 'woz.wepublish.media'

const domainMedia = `media.${domain}`
const domainAPI = `api.${domain}`

const image = `${GOOGLE_REGISTRY_HOST_NAME}/${PROJECT_ID}/${GITHUB_REPOSITORY}/main:${GITHUB_SHA}`

main().catch(e => {
  process.stderr.write(e.toString())
  process.exit(1)
})

async function main() {
  await applyNamespace()
  await applyMediaServer()
  await applyApiServer()
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

async function applyMediaServer() {
  const image = `${GOOGLE_REGISTRY_HOST_NAME}/${PROJECT_ID}/${GITHUB_REPOSITORY}/media:${GITHUB_SHA}`
  const app = 'media'
  const appName = `${app}-${ENVIRONMENT_NAME}`
  const appPort = 3004

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
              image: image,
              env: [
                {
                  name: 'NODE_ENV',
                  value: `production`
                },
                {
                  name: 'STORAGE_PATH',
                  value: '/home/node/app/.media'
                },
                {
                  name: 'NUM_CLUSTERS',
                  value: '1'
                },
                {
                  name: 'TOKEN',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'wepublish-woz-secrets',
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
                  cpu: '100m',
                  memory: '256Mi'
                }
              },
              terminationMessagePath: '/dev/termination-log',
              terminationMessagePolicy: 'File',
              volumeMounts: [
                {
                  name: 'media-volume',
                  mountPath: '/home/node/app/.media'
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
              gcePersistentDisk: {
                fsType: 'ext4',
                pdName: 'wepublish-woz-media-production',
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
    apiVersion: 'extensions/v1beta1',
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
          secretName: `${appName}-tls`
        }
      ]
    }
  }
  await applyConfig(`ingress-${app}`, ingress)
}

async function applyApiServer() {
  const image = `${GOOGLE_REGISTRY_HOST_NAME}/${PROJECT_ID}/${GITHUB_REPOSITORY}/api:${GITHUB_SHA}`
  const app = 'api'
  const appName = `${app}-${ENVIRONMENT_NAME}`
  const appPort = 3005

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
              image: image,
              env: [
                {
                  name: 'NODE_ENV',
                  value: `production`
                },
                {
                  name: 'MEDIA_SERVER_URL',
                  value: `https://${domainMedia}`
                },
                {
                  name: 'MEDIA_SERVER_TOKEN',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'wepublish-woz-secrets',
                      key: 'media_server_token'
                    }
                  }
                },
                {
                  name: 'PORT',
                  value: '3005'
                },
                {
                  name: 'HOST_ENV',
                  value: 'production'
                },
                {
                  name: 'HOST_URL',
                  value: 'https://api.woz.wepublish.media'
                },
                {
                  name: 'MONGO_URL',
                  value: 'mongodb://mongo-production:27017/woz-wepublish'
                },
                {
                  name: 'MONGO_LOCALE',
                  value: 'de'
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
                  cpu: '300m',
                  memory: '256Mi'
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
    apiVersion: 'extensions/v1beta1',
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
          secretName: `${appName}-tls`
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
              gcePersistentDisk: {
                fsType: 'ext4',
                pdName: 'wepublish-woz-mongo-production'
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
