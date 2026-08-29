# API Documentation

Complete API reference for Motiv Backend Icon Service.

## Base URL

```
http://localhost:3000
```

For production, replace with your domain.

---

## Authentication

**Current Version**: No authentication required (public API)

**Future**: Bearer token authentication for admin endpoints

---

## Rate Limiting

**Current**: No rate limiting  
**Planned**: 1000 requests/hour per IP

---

## Response Format

### Success Response

```json
{
  "success": true,
  "data": { ... }
}
```

### Error Response

```json
{
  "statusCode": 404,
  "message": "Collection 'invalid' not found",
  "error": "Not Found"
}
```

---

## Endpoints

## 1. Health Check

Check server health and get system metrics.

### Request

```http
GET /health
```

### Response

```json
{
  "status": "ok",
  "timestamp": "2026-08-29T07:29:57.926Z",
  "uptime": 58.56,
  "memory": {
    "used": 568,
    "total": 653
  }
}
```

### Status Codes

| Code | Description |
|------|-------------|
| 200 | Server is healthy |

---

## 2. Get All Collections

Retrieve list of all available icon collections.

### Request

```http
GET /api/icons/collections
```

### Response

```json
{
  "success": true,
  "data": {
    "version": "1.0.0",
    "lastUpdated": "2026-08-29T04:36:19.583Z",
    "totalCollections": 111,
    "totalIcons": 175418,
    "collections": [
      {
        "id": "material-symbols",
        "name": "Material Symbols",
        "total": 31287,
        "styles": ["rounded", "thin"]
      },
      {
        "id": "lucide",
        "name": "Lucide",
        "total": 1786,
        "styles": ["outline"]
      }
    ]
  }
}
```

### Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |

---

## 3. Get Collection Metadata

Get detailed metadata for a specific collection.

### Request

```http
GET /api/icons/collection/:collectionId
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `collectionId` | string | Yes | Collection identifier (e.g., "lucide") |

### Example

```bash
curl http://localhost:3000/api/icons/collection/lucide
```

### Response

```json
{
  "success": true,
  "data": {
    "id": "lucide",
    "name": "Lucide",
    "displayName": "Lucide",
    "total": 1786,
    "styles": ["outline"],
    "categories": ["UI"],
    "defaultViewBox": "0 0 24 24",
    "updated": "2026-08-29T04:36:08.768Z"
  }
}
```

### Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 404 | Collection not found |

---

## 4. Get Icons from Collection

Retrieve icons from a specific collection with pagination and filtering.

### Request

```http
GET /api/icons/collection/:collectionId/icons
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `collectionId` | string | Yes | - | Collection identifier |
| `limit` | number | No | 50 | Icons per page (max 200) |
| `offset` | number | No | 0 | Pagination offset |
| `category` | string | No | - | Filter by category |
| `style` | string | No | - | Filter by style |
| `search` | string | No | - | Search in icon names/tags |

### Examples

```bash
# Get first 50 icons
curl "http://localhost:3000/api/icons/collection/lucide/icons?limit=50&offset=0"

# Filter by style
curl "http://localhost:3000/api/icons/collection/heroicons/icons?style=outline"

# Search within collection
curl "http://localhost:3000/api/icons/collection/lucide/icons?search=arrow"

# Pagination
curl "http://localhost:3000/api/icons/collection/tabler/icons?limit=20&offset=100"
```

### Response

```json
{
  "success": true,
  "data": {
    "icons": [
      {
        "id": "lucide_outline_a-arrow-down",
        "name": "a-arrow-down",
        "category": "UI",
        "tags": ["a-arrow-down", "lucide", "outline"],
        "style": "outline",
        "viewBox": "0 0 24 24",
        "svg": "<g fill=\"none\" stroke=\"currentColor\"...>"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 1786
    }
  }
}
```

### Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 404 | Collection not found |

---

## 5. Get SVG Icon

Get an SVG icon with optional customization.

### Request

```http
GET /api/icons/:collectionId/:iconName.svg
```

### Parameters

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `collectionId` | string | Yes | Collection identifier |
| `iconName` | string | Yes | Icon name (with or without .svg) |

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `color` | string | No | currentColor | Hex color without # (e.g., "ff0000") |
| `size` | number | No | 24 | Width and height in pixels |
| `stroke` | number | No | 2 | Stroke width |

### Examples

```bash
# Default icon
curl "http://localhost:3000/api/icons/lucide/heart.svg"

# Red heart, 48px
curl "http://localhost:3000/api/icons/lucide/heart.svg?color=ff0000&size=48"

# Custom color, size, and stroke
curl "http://localhost:3000/api/icons/lucide/arrow-right.svg?color=3b82f6&size=32&stroke=3"

# Blue check icon
curl "http://localhost:3000/api/icons/phosphor/check.svg?color=10b981"
```

### Response

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">
  <g fill="none" stroke="#ff0000" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
  </g>
</svg>
```

### Response Headers

```
Content-Type: image/svg+xml
Cache-Control: public, max-age=604800, immutable
ETag: "lucide-heart-v1"
```

### Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 404 | Icon or collection not found |

---

## 6. Search Icons

Search for icons across all collections or specific collections.

### Request

```http
GET /api/icons/search
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | Yes | - | Search query |
| `collection` | string | No | - | Filter by collections (comma-separated) |
| `category` | string | No | - | Filter by category |
| `style` | string | No | - | Filter by style |
| `limit` | number | No | 50 | Results per page (max 200) |
| `offset` | number | No | 0 | Pagination offset |

### Examples

```bash
# Simple search
curl "http://localhost:3000/api/icons/search?q=arrow"

# Search in specific collection
curl "http://localhost:3000/api/icons/search?q=heart&collection=lucide"

# Search with style filter
curl "http://localhost:3000/api/icons/search?q=user&style=outline"

# Search in multiple collections
curl "http://localhost:3000/api/icons/search?q=home&collection=lucide,heroicons"

# Paginated search
curl "http://localhost:3000/api/icons/search?q=arrow&limit=20&offset=40"
```

### Response

```json
{
  "success": true,
  "data": {
    "query": "arrow",
    "total": 6587,
    "results": [
      {
        "id": "lucide_outline_arrow-right",
        "name": "arrow-right",
        "collection": "lucide",
        "category": "UI",
        "tags": ["arrow-right", "lucide", "outline"],
        "style": "outline"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0
    }
  }
}
```

### Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Missing query parameter |

---

## Error Codes

### Common HTTP Status Codes

| Code | Name | Description |
|------|------|-------------|
| 200 | OK | Request successful |
| 400 | Bad Request | Invalid parameters |
| 404 | Not Found | Resource not found |
| 500 | Internal Server Error | Server error |

### Error Response Format

```json
{
  "statusCode": 404,
  "message": "Collection 'invalid' not found",
  "error": "Not Found"
}
```

---

## Caching

### Client-Side Caching

SVG responses include cache headers:

```
Cache-Control: public, max-age=604800, immutable
ETag: "collection-icon-v1"
```

**Recommendations:**
- Cache SVG responses for 7 days
- Use ETag for conditional requests (304 Not Modified)
- CDN will cache automatically

### Server-Side Caching

Collections and icons are cached in memory using LRU:

- **Collections**: 500MB, 1 hour TTL
- **Icons**: 50MB, 30 minutes TTL

---

## Rate Limits (Planned)

Future rate limits:

| Tier | Requests/Hour | Cost |
|------|---------------|------|
| **Free** | 1,000 | Free |
| **Pro** | 10,000 | $9/mo |
| **Enterprise** | Unlimited | Custom |

---

## CORS

CORS is enabled for all origins by default:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
```

For production, configure specific origins in `.env`:

```env
CORS_ORIGIN=https://yourdomain.com
```

---

## SDK Examples

### JavaScript/TypeScript

```typescript
// Fetch collections
const response = await fetch('http://localhost:3000/api/icons/collections');
const data = await response.json();
console.log(data.data.collections);

// Get SVG icon
const icon = await fetch('http://localhost:3000/api/icons/lucide/heart.svg?color=ff0000&size=32');
const svg = await icon.text();
document.getElementById('icon').innerHTML = svg;

// Search icons
const results = await fetch('http://localhost:3000/api/icons/search?q=arrow&limit=20');
const icons = await results.json();
```

### React Example

```tsx
import { useEffect, useState } from 'react';

function IconComponent({ collection, name, color = 'currentColor', size = 24 }) {
  const [svg, setSvg] = useState('');

  useEffect(() => {
    fetch(`http://localhost:3000/api/icons/${collection}/${name}.svg?color=${color}&size=${size}`)
      .then(res => res.text())
      .then(setSvg);
  }, [collection, name, color, size]);

  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}

// Usage
<IconComponent collection="lucide" name="heart" color="ff0000" size={32} />
```

---

## Testing

Import `postman_collection.json` for complete test suite with 25+ requests.

---

## Support

- **Issues**: [GitHub Issues](https://github.com/sirenuix/motiv-backend/issues)
- **Documentation**: [../README.md](../README.md)
