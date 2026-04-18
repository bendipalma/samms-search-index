#!/usr/bin/env node
/**
 * build-search-index.js
 *
 * Scrapes your published Framer site and builds a search-index.json file
 * that you can upload to Framer's assets. Your search component fetches
 * that JSON at runtime and searches across everything on the site.
 *
 * HOW TO USE (local):
 *   1. Make a new folder for this script: mkdir samms-search-builder
 *   2. Put this file and package.json in it
 *   3. npm install
 *   4. node build-search-index.js https://beautiful-changes-429467.framer.app
 *   5. Upload the resulting search-index.json to Framer (Assets → Upload)
 *   6. Paste the Framer-hosted URL into your SiteWideSearch component
 *
 * HOW TO USE (automated via GitHub Actions):
 *   See the README on Desktop — commit this script + the workflow file
 *   and it'll rebuild the index daily.
 *
 * Matching package.json contents (create this file alongside):
 *   {
 *     "name": "samms-search-builder",
 *     "version": "1.0.0",
 *     "type": "module",
 *     "dependencies": {
 *       "cheerio": "^1.0.0"
 *     }
 *   }
 */

import * as cheerio from "cheerio"
import { writeFileSync } from "fs"

const SITE_URL = process.argv[2]
if (!SITE_URL) {
    console.error("Usage: node build-search-index.js <site-url>")
    console.error(
        "Example: node build-search-index.js https://beautiful-changes-429467.framer.app"
    )
    process.exit(1)
}

const OUTPUT_FILE = "search-index.json"
const CONCURRENCY = 5 // Pages fetched in parallel

// Map URL paths to human-readable collection labels. Order matters — first
// match wins. Extend this as you add new content sections.
const COLLECTION_PATTERNS = [
    { pattern: /^\/case-studies(\/|$)/, label: "Case Studies" },
    { pattern: /^\/advocacy-policy-news(\/|$)/, label: "Articles" },
    { pattern: /^\/webinars(\/|$)/, label: "Webinars" },
    { pattern: /^\/resources(\/|$)/, label: "Resources" },
    { pattern: /^\/impact-hub(\/|$)/, label: "Impact Hub" },
]

// URLs to skip entirely (legal pages, 404s, etc.) — adjust as needed.
const EXCLUDE_PATTERNS = [
    /\/terms-of-service/i,
    /\/privacy-policy/i,
    /\/404/i,
    /\/sitemap/i,
    /\/banana/i,
]

function classifyUrl(url) {
    const pathname = new URL(url).pathname
    for (const { pattern, label } of COLLECTION_PATTERNS) {
        if (pattern.test(pathname)) return label
    }
    return null // Not a CMS collection — will be excluded
}

function shouldExclude(url) {
    const pathname = new URL(url).pathname
    return EXCLUDE_PATTERNS.some((p) => p.test(pathname))
}

async function fetchSitemap() {
    const url = new URL("/sitemap.xml", SITE_URL).href
    console.log(`Fetching sitemap: ${url}`)
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(
            `Failed to fetch sitemap (${response.status}). ` +
                `Is the site published? Try visiting ${url} in your browser.`
        )
    }
    const xml = await response.text()
    const matches = xml.matchAll(/<loc>([^<]+)<\/loc>/g)
    // Rewrite URLs to use the target SITE_URL — Framer's sitemap may list
    // a custom domain even when we're scraping the preview domain.
    const base = new URL(SITE_URL)
    return [...matches]
        .map((m) => {
            const parsed = new URL(m[1])
            parsed.protocol = base.protocol
            parsed.host = base.host
            return parsed.href
        })
        .filter((u) => !shouldExclude(u))
}

async function scrapePage(url) {
    try {
        const response = await fetch(url, {
            headers: { "User-Agent": "SAMMs-Search-Indexer/1.0" },
        })
        if (!response.ok) {
            console.warn(`  ⚠  Skipping ${url} (HTTP ${response.status})`)
            return null
        }
        const html = await response.text()
        const $ = cheerio.load(html)

        // Prefer Open Graph when available — usually cleaner than <title>
        let title = (
            $('meta[property="og:title"]').attr("content") ||
            $("title").text() ||
            ""
        ).trim()

        // Strip generic Framer suffixes
        title = title.replace(/\s*-\s*My Framer Site$/i, "").trim()

        // If the title is generic/fallback, derive a readable one from the URL slug
        const GENERIC_TITLES = [
            "samms | turning complexity into capacity",
            "samms",
            "",
        ]
        if (GENERIC_TITLES.includes(title.toLowerCase())) {
            const slug = new URL(url).pathname.split("/").filter(Boolean).pop()
            if (slug) {
                title = slug
                    .replace(/-/g, " ")
                    .replace(/\b\w/g, (c) => c.toUpperCase())
            }
        }

        const description = (
            $('meta[property="og:description"]').attr("content") ||
            $('meta[name="description"]').attr("content") ||
            ""
        ).trim()

        // Grab visible body text (capped) for deeper matches beyond title.
        // Remove scripts/styles first so we don't capture noise.
        $("script, style, noscript").remove()
        const bodyText = $("body")
            .text()
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 2000) // Keep the index small

        if (!title) return null

        const collection = classifyUrl(url)
        if (!collection) return null // Skip non-CMS pages

        return {
            url,
            title,
            description,
            body: bodyText,
            collection,
        }
    } catch (err) {
        console.warn(`  ⚠  Error fetching ${url}: ${err.message}`)
        return null
    }
}

// Fetch pages in batches so we don't hammer the server with 100 parallel
// requests if the site is large.
async function processInBatches(urls, batchSize) {
    const results = []
    for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize)
        console.log(
            `  Processing ${i + 1}-${Math.min(i + batchSize, urls.length)} of ${urls.length}...`
        )
        const batchResults = await Promise.all(batch.map(scrapePage))
        results.push(...batchResults.filter(Boolean))
    }
    return results
}

async function main() {
    const urls = await fetchSitemap()
    console.log(`Found ${urls.length} URLs to index\n`)

    const items = await processInBatches(urls, CONCURRENCY)

    // Group summary by collection for the console output
    const summary = items.reduce((acc, item) => {
        acc[item.collection] = (acc[item.collection] || 0) + 1
        return acc
    }, {})

    writeFileSync(OUTPUT_FILE, JSON.stringify(items, null, 2))

    console.log(`\n✓ Wrote ${items.length} items to ${OUTPUT_FILE}`)
    console.log("\nBy collection:")
    for (const [label, count] of Object.entries(summary).sort()) {
        console.log(`  ${label}: ${count}`)
    }
    console.log(
        `\nNext step: upload ${OUTPUT_FILE} to Framer (Assets → Upload)`
    )
    console.log(
        "then paste the Framer-hosted URL into your SiteWideSearch component's Data URL prop."
    )
}

main().catch((err) => {
    console.error("\n✗ Build failed:", err.message)
    process.exit(1)
})
