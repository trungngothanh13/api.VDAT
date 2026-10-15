export const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'VDAT API — Vehicle Detection & Red-Light Violation Monitoring',
    version: '1.0.0',
    description:
      'Interactive Swagger documentation for the **VDAT** backend service. Includes REST endpoints for authentication, camera zone management, violation review workflows, evidence file handling, and real-time analytics.',
    contact: {
      name: 'VDAT Project Team',
    },
  },
  servers: [
    {
      url: 'http://localhost:5000',
      description: 'Local Development Server',
    },
    {
      url: 'https://api-vdat.onrender.com',
      description: 'Render Cloud Production',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter your JWT token obtained from `/api/auth/login`.',
      },
    },
    schemas: {
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: {
            type: 'string',
            example: 'admin@vdat.local',
          },
          password: {
            type: 'string',
            example: 'admin123',
          },
        },
      },
      LoginResponse: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          user: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              fullName: { type: 'string' },
              role: { type: 'string', enum: ['POLICE', 'ADMIN'] },
            },
          },
        },
      },
      UpdateZoneRequest: {
        type: 'object',
        required: ['lanes', 'intersection'],
        properties: {
          lanes: {
            type: 'array',
            description: 'Array of polygon coordinates defining lanes',
            example: [
              [
                [429, 161], [433, 247], [550, 230], [560, 213],
                [577, 213], [581, 203], [637, 181], [696, 167],
                [730, 158], [717, 139], [601, 148], [584, 142],
                [434, 156]
              ]
            ],
          },
          intersection: {
            type: 'array',
            description: 'Polygon coordinates defining the intersection area',
            example: [
              [429, 157], [432, 246], [226, 273], [149, 293],
              [154, 186], [205, 171], [426, 158]
            ],
          },
          lightBox: {
            type: 'array',
            description: 'Traffic light color sampling boxes',
            example: [
              { x: 570, y: 148, color: 'green' },
              { x: 570, y: 130, color: 'red' }
            ],
          },
        },
      },
      UpdateViolationStatusRequest: {
        type: 'object',
        required: ['status'],
        properties: {
          status: {
            type: 'string',
            enum: ['CONFIRMED', 'DISMISSED'],
            example: 'CONFIRMED',
          },
          notes: {
            type: 'string',
            example: 'Clear red-light crossing confirmed from evidence video clip.',
          },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Service Health Check',
        responses: {
          200: {
            description: 'Service is operational',
            content: {
              'application/json': {
                example: {
                  status: 'UP',
                  service: 'api.VDAT',
                  timestamp: '2026-10-15T09:28:38.914Z',
                },
              },
            },
          },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Authenticate User (Admin or Officer)',
        description:
          'Default accounts:\n- **Admin**: `admin@vdat.local` / `admin123`\n- **Officer**: `officer@vdat.local` / `police123`',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Successful login',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LoginResponse' },
              },
            },
          },
          401: { description: 'Invalid email or password' },
        },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Get Current Authenticated Profile',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'User profile details' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    '/api/cameras': {
      get: {
        tags: ['Cameras'],
        summary: 'List All Cameras',
        description: 'Returns all registered cameras with live streaming status and total violation counts.',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'List of cameras' },
        },
      },
    },
    '/api/cameras/{id}': {
      get: {
        tags: ['Cameras'],
        summary: 'Get Camera Details & Zone Configuration',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'cam-01' },
          },
        ],
        responses: {
          200: { description: 'Camera details with zone polygon coordinates' },
          404: { description: 'Camera not found' },
        },
      },
    },
    '/api/cameras/{id}/zones': {
      put: {
        tags: ['Cameras'],
        summary: 'Update Zone Geometry & Sync with AI Engine',
        description:
          'Updates lane and intersection polygon boundaries in PostgreSQL, and pushes the new configuration in real time to the AI engine on ThunderCompute.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'cam-01' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateZoneRequest' },
            },
          },
        },
        responses: {
          200: { description: 'Zones updated and synced successfully' },
        },
      },
    },
    '/api/violations': {
      get: {
        tags: ['Violations'],
        summary: 'List Paginated Violations with Filters',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'cameraId', in: 'query', schema: { type: 'string', example: 'cam-01' } },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['PENDING_REVIEW', 'CONFIRMED', 'DISMISSED'] },
          },
          { name: 'vehicleClass', in: 'query', schema: { type: 'string', example: 'motorcycle' } },
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          200: { description: 'Paginated violation log' },
        },
      },
    },
    '/api/violations/{id}': {
      get: {
        tags: ['Violations'],
        summary: 'Get Violation Details with Evidence Links',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: { description: 'Violation record' },
          404: { description: 'Violation not found' },
        },
      },
    },
    '/api/violations/{id}/status': {
      patch: {
        tags: ['Violations'],
        summary: 'Review Violation (Confirm or Dismiss)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateViolationStatusRequest' },
            },
          },
        },
        responses: {
          200: { description: 'Violation reviewed successfully' },
        },
      },
    },
    '/api/evidence/upload': {
      post: {
        tags: ['Evidence'],
        summary: 'Upload Evidence Video Clip (MP4) or Snapshot (JPG)',
        description: 'Used by ThunderCompute to upload the completed evidence video clips and high-resolution snapshots.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'MP4 evidence clip or JPG snapshot image',
                  },
                  cameraId: { type: 'string', example: 'cam-01' },
                  trackId: { type: 'integer', example: 123 },
                  frameNumber: { type: 'integer', example: 599 },
                  violationId: { type: 'string', description: 'Optional: ID of violation to link directly' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Evidence uploaded and linked to violation' },
        },
      },
    },
    '/api/stats/overview': {
      get: {
        tags: ['Analytics'],
        summary: 'Get Dashboard Analytics Overview',
        description: 'Returns total violations count, pending reviews, active camera counts, and breakdown by vehicle class.',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Statistical metrics' },
        },
      },
    },
  },
};
