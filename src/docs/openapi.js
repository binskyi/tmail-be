export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Temporary Email Backend API',
    version: '1.0.0',
    description: 'Inbound-only temporary email API with Haraka, Redis, workers, WebSocket, and domain tracking.'
  },
  servers: [
    {
      url: 'https://prod.pusat.email/api/v1',
      description: 'Production API'
    },
    {
      url: '/api/v1',
      description: 'Current API host'
    }
  ],
  components: {
    securitySchemes: {
      AdminToken: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Admin-Token'
      }
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' }
        }
      },
      InboxMessage: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          from: { type: 'string' },
          subject: { type: 'string' },
          timestamp: { type: 'integer', format: 'int64' },
          is_otp: { type: 'boolean', example: true },
          otp: { type: 'string', nullable: true, example: '123456' }
        }
      },
      IncomingDomain: {
        type: 'object',
        properties: {
          domain: { type: 'string', example: 'example.com' },
          last_seen_at: { type: 'integer', format: 'int64' },
          total_messages: { type: 'integer', example: 12 },
          mx_valid: { type: 'boolean', example: true },
          source: {
            type: 'string',
            enum: ['incoming', 'mx_status'],
            description: 'Present on /random-domain. incoming means seen from inbound email, mx_status means recorded from a valid domain status check.'
          }
        }
      },
      PublicDomain: {
        type: 'object',
        properties: {
          domain: { type: 'string', example: 'pusat.email' },
          visibility: { type: 'string', enum: ['public'], example: 'public' },
          created_at: { type: 'integer', format: 'int64', example: 0 },
          updated_at: { type: 'integer', format: 'int64', example: 0 },
          built_in: { type: 'boolean', example: true }
        }
      },
      DomainStatus: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          active: { type: 'boolean' },
          approved: { type: 'boolean' },
          approved_at: { type: 'integer', nullable: true },
          uptime_seconds: { type: 'integer' },
          uptime_days: { type: 'integer' },
          uptime_label: { type: 'string', nullable: true },
          status_label: { type: 'string' },
          registered: { type: 'boolean' },
          visibility: { type: 'string', nullable: true },
          built_in: { type: 'boolean' },
          mx_valid: { type: 'boolean' },
          required_mx: { type: 'string' },
          active_reason: { type: 'string' }
        }
      },
      SystemStatus: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded'] },
          timestamp: { type: 'integer', format: 'int64' },
          app: { type: 'object' },
          host: { type: 'object' },
          cpu: { type: 'object' },
          memory: { type: 'object' },
          services: { type: 'object' },
          storage: { type: 'object' }
        }
      }
    }
  },
  paths: {
    '/swagger': {
      get: {
        summary: 'Open Swagger UI',
        description: 'Browser-based API documentation page served by this API.',
        responses: {
          200: {
            description: 'Swagger UI HTML',
            content: {
              'text/html': {
                schema: { type: 'string' }
              }
            }
          }
        }
      }
    },
    '/swagger.json': {
      get: {
        summary: 'OpenAPI JSON document',
        description: 'Raw OpenAPI 3.0 document used by Swagger UI.',
        responses: {
          200: {
            description: 'OpenAPI JSON',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    },
    '/generate': {
      get: {
        summary: 'Generate a temporary email address',
        parameters: [
          {
            name: 'domain',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Optional public registered domain.'
          }
        ],
        responses: {
          200: {
            description: 'Generated address',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    email: { type: 'string', example: 'abc123@pusat.email' },
                    domain: { type: 'string', example: 'pusat.email' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/inbox': {
      get: {
        summary: 'Read inbox messages',
        parameters: [
          {
            name: 'email',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'email' }
          }
        ],
        responses: {
          200: {
            description: 'Inbox message list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    email: { type: 'string' },
                    messages: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/InboxMessage' }
                    }
                  }
                }
              }
            }
          },
          400: { description: 'Invalid email', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        }
      },
      delete: {
        summary: 'Delete all messages in an inbox',
        security: [{ AdminToken: [] }],
        parameters: [
          {
            name: 'email',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'email' }
          }
        ],
        responses: {
          200: { description: 'Inbox deleted' },
          401: { description: 'Unauthorized' }
        }
      }
    },
    '/messages/{id}': {
      get: {
        summary: 'Read message detail',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' }
          }
        ],
        responses: {
          200: { description: 'Message detail' },
          404: { description: 'Message not found' }
        }
      },
      delete: {
        summary: 'Delete a message',
        security: [{ AdminToken: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' }
          }
        ],
        responses: {
          200: { description: 'Message deleted' },
          404: { description: 'Message not found' },
          401: { description: 'Unauthorized' }
        }
      }
    },
    '/list-domain': {
      get: {
        summary: 'List domains seen from incoming email',
        description:
          'Returns unique recipient domains recorded when inbound email is processed and the domain MX points to the configured required MX host. Page size is capped at 20.',
        parameters: [
          {
            name: 'page',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, default: 1 }
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 20, default: 20 }
          }
        ],
        responses: {
          200: {
            description: 'Paginated incoming domains',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                    total_domains: { type: 'integer' },
                    total_pages: { type: 'integer' },
                    last_page: { type: 'integer' },
                    domains: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/IncomingDomain' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/domains': {
      get: {
        summary: 'List public domains available for generation',
        responses: {
          200: {
            description: 'Public domains',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    domains: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/PublicDomain' }
                    }
                  }
                },
                example: {
                  domains: [
                    {
                      domain: 'pusat.email',
                      visibility: 'public',
                      created_at: 0,
                      updated_at: 0,
                      built_in: true
                    }
                  ]
                }
              }
            }
          }
        }
      }
    },
    '/random-domain': {
      get: {
        summary: 'List up to 10 random incoming MX-valid domains',
        description:
          'Returns a random de-duplicated sample from MX-valid incoming domains and domains that were recorded from successful domain status checks. The result is capped at 10 domains.',
        responses: {
          200: {
            description: 'Random incoming domains',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    domains: {
                      type: 'array',
                      maxItems: 10,
                      items: { $ref: '#/components/schemas/IncomingDomain' }
                    },
                    total_domains: { type: 'integer' },
                    limit: { type: 'integer', example: 10 }
                  }
                },
                example: {
                  domains: [
                    {
                      domain: 'pusat.email',
                      last_seen_at: 1779811148095,
                      total_messages: 8,
                      mx_valid: true,
                      source: 'incoming'
                    }
                  ],
                  total_domains: 5,
                  limit: 10
                }
              }
            }
          }
        }
      }
    },
    '/domains/status': {
      get: {
        summary: 'Check domain status',
        parameters: [
          {
            name: 'domain',
            in: 'query',
            required: true,
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: {
            description: 'Domain status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DomainStatus' } } }
          }
        }
      }
    },
    '/domains/{domain}/status': {
      get: {
        summary: 'Check domain status by path parameter',
        parameters: [
          {
            name: 'domain',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: {
            description: 'Domain status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DomainStatus' } } }
          }
        }
      }
    },
    '/health': {
      get: {
        summary: 'Health check',
        responses: {
          200: { description: 'Healthy' },
          503: { description: 'Redis unavailable' }
        }
      }
    },
    '/system/status': {
      get: {
        summary: 'Detailed system and dependency status',
        description:
          'Admin-only operational status with app and host uptime, current dependency downtime state, CPU usage, RAM usage, Redis details, Haraka TCP health, queue metrics, storage, and WebSocket status.',
        security: [{ AdminToken: [] }],
        responses: {
          200: {
            description: 'System is healthy',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SystemStatus' } } }
          },
          503: {
            description: 'One or more dependencies are degraded',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SystemStatus' } } }
          },
          401: { description: 'Unauthorized' }
        }
      }
    },
    '/admin/domains': {
      get: {
        summary: 'Admin list all active domains',
        security: [{ AdminToken: [] }],
        responses: {
          200: { description: 'All active domains' },
          401: { description: 'Unauthorized' }
        }
      },
      post: {
        summary: 'Admin add domain',
        security: [{ AdminToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['domain'],
                properties: {
                  domain: { type: 'string', example: 'example.com' },
                  visibility: { type: 'string', enum: ['public', 'private'], default: 'public' },
                  verify_mx: { type: 'boolean', default: true }
                }
              }
            }
          }
        },
        responses: {
          201: { description: 'Domain created' },
          401: { description: 'Unauthorized' },
          422: { description: 'MX does not point to required host' }
        }
      }
    },
    '/admin/domains/{domain}/status': {
      get: {
        summary: 'Admin check domain status',
        security: [{ AdminToken: [] }],
        parameters: [{ name: 'domain', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Domain status' },
          401: { description: 'Unauthorized' }
        }
      }
    },
    '/admin/domains/{domain}': {
      delete: {
        summary: 'Admin delete domain',
        security: [{ AdminToken: [] }],
        parameters: [{ name: 'domain', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Domain deleted' },
          404: { description: 'Domain not found' },
          401: { description: 'Unauthorized' }
        }
      }
    },
    '/admin/domains/{domain}/messages': {
      delete: {
        summary: 'Admin delete all messages for a domain',
        security: [{ AdminToken: [] }],
        parameters: [{ name: 'domain', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Domain messages deleted' },
          401: { description: 'Unauthorized' }
        }
      }
    }
  }
};
