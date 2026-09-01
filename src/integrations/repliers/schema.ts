import { z } from 'zod'

/**
 * Repliers response shapes.
 *
 * Built from real captured responses in `test/fixtures/repliers/`, not from
 * documentation — see rule 2 in `CLAUDE.md`. Anything changed here should be
 * changed because a new capture says so.
 *
 * Two rules decide whether a field is strict or nullable, because getting this
 * wrong costs in both directions — too strict and a legitimate listing fails to
 * parse, too loose and a silently-renamed field reaches the fill engine as a
 * blank:
 *
 *  - **Strict** (`z.string()`, `z.number()`) only for fields that are never
 *    null across the captured sample *and* identify the listing: the MLS
 *    number, the price, the street, the city. If one of those goes missing the
 *    response is not a listing we can use, and failing loudly is correct.
 *  - **`.nullish()`** for everything else. Repliers returns explicit nulls for
 *    unset fields, and narrowing a response with the `fields` parameter drops
 *    keys entirely, so absent and null are the same answer.
 *
 * Unknown keys are stripped rather than rejected (Zod's default). Repliers
 * adding a field must not break us; changing one we read must.
 */

/**
 * Street address, split into parts.
 *
 * `country` is null on more than a third of the captured sample even though
 * every one of those listings is American, so it is not load-bearing.
 */
export const repliersAddressSchema = z.object({
    streetNumber: z.string(),
    streetName: z.string(),
    streetSuffix: z.string().nullish(),
    streetDirection: z.string().nullish(),
    streetDirectionPrefix: z.string().nullish(),
    unitNumber: z.string().nullish(),
    city: z.string(),

    // `state` for a US board, and the province for a Canadian one. The name is
    // Repliers'; the domain calls it province.
    state: z.string(),
    zip: z.string().nullish(),
    country: z.string().nullish(),
    area: z.string().nullish(),
    district: z.string().nullish(),
    neighborhood: z.string().nullish(),
    majorIntersection: z.string().nullish(),
    communityCode: z.string().nullish(),
    addressKey: z.string().nullish()
})

export type RepliersAddress = z.infer<typeof repliersAddressSchema>

/**
 * Lot dimensions.
 *
 * `size` arrives as a string on some listings and a number on others — both
 * appear in a single 50-listing sample, so the union is the captured reality
 * rather than defensiveness.
 *
 * `width` and `depth` are null on every listing the sandbox returns. They are
 * the source for the OREA frontage and depth blanks, so that is a gap the
 * property form has to survive rather than a schema question.
 */
export const repliersLotSchema = z.object({
    width: z.union([z.string(), z.number()]).nullish(),
    depth: z.union([z.string(), z.number()]).nullish(),
    size: z.union([z.string(), z.number()]).nullish(),
    squareFeet: z.number().nullish(),
    acres: z.number().nullish(),
    dimensions: z.string().nullish(),
    measurement: z.string().nullish(),
    legalDescription: z.string().nullish(),
    features: z.string().nullish(),
    irregular: z.string().nullish(),
    taxLot: z.string().nullish()
})

export type RepliersLot = z.infer<typeof repliersLotSchema>

/**
 * `annualAmount` is null on every listing in the sandbox, and it is what fills
 * the taxes blank on Form 100. Treated as a number when present; a string would
 * mean the upstream shape moved and is worth failing on.
 */
export const repliersTaxesSchema = z.object({
    annualAmount: z.number().nullish(),
    assessmentYear: z.string().nullish()
})

/** Only the details the property form reads. The object carries far more. */
export const repliersDetailsSchema = z.object({
    propertyType: z.string().nullish(),
    style: z.string().nullish(),
    description: z.string().nullish(),
    sqft: z.union([z.string(), z.number()]).nullish(),
    numBedrooms: z.number().nullish(),
    numBathrooms: z.number().nullish(),
    numGarageSpaces: z.number().nullish(),
    numParkingSpaces: z.number().nullish(),
    yearBuilt: z.union([z.string(), z.number()]).nullish()
})

export const repliersMapSchema = z.object({
    latitude: z.number().nullish(),
    longitude: z.number().nullish()
})

export const repliersOfficeSchema = z.object({
    brokerageName: z.string().nullish()
})

/**
 * One listing.
 *
 * The same shape comes back from the search and the detail endpoint; the detail
 * response carries `comparables` and `history` in addition, which nothing here
 * reads and which are therefore stripped.
 */
export const repliersListingSchema = z.object({
    mlsNumber: z.string(),
    listPrice: z.number(),
    originalPrice: z.number().nullish(),
    soldPrice: z.number().nullish(),
    listDate: z.string().nullish(),
    soldDate: z.string().nullish(),

    // `status` is a one-letter code ("A"), `lastStatus` and `standardStatus`
    // are words ("New", "Active"). Left as free strings: the set of codes a
    // board can send is not in the captured sample, and an enum would reject a
    // listing for a status we simply have not seen.
    status: z.string(),
    lastStatus: z.string().nullish(),
    standardStatus: z.string().nullish(),

    class: z.string().nullish(),
    type: z.string().nullish(),
    boardId: z.number().nullish(),
    daysOnMarket: z.number().nullish(),
    photoCount: z.number().nullish(),
    updatedOn: z.string().nullish(),

    address: repliersAddressSchema,
    lot: repliersLotSchema.nullish(),
    taxes: repliersTaxesSchema.nullish(),
    details: repliersDetailsSchema.nullish(),
    map: repliersMapSchema.nullish(),
    office: repliersOfficeSchema.nullish(),
    images: z.array(z.string()).nullish()
})

export type RepliersListing = z.infer<typeof repliersListingSchema>

/**
 * The search envelope.
 *
 * `count` is the total across all pages, not the length of `listings` — 42,886
 * against a two-item page in the capture. Reporting the wrong one to the agent
 * would be its own bug.
 */
export const repliersSearchResponseSchema = z.object({
    page: z.number(),
    numPages: z.number(),
    pageSize: z.number(),
    count: z.number(),
    apiVersion: z.number().nullish(),

    // Repliers echoes any query parameter it did not understand instead of
    // erroring. A typo'd filter therefore returns unfiltered results, which is
    // worth surfacing rather than quietly trusting.
    unrecognizedParams: z.array(z.string()).nullish(),

    listings: z.array(repliersListingSchema)
})

export type RepliersSearchResponse = z.infer<typeof repliersSearchResponseSchema>
