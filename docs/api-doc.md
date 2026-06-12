# @intelligent-farming/lorawan-codec-normalization

`@intelligent-farming/lorawan-codec-normalization`

Curated, standalone normalized LoRaWAN payload codecs for agriculture
sensors. Every codec in a category emits the same shared keys, drawn from a
fixed vocabulary (see `definitions/vocabulary.schema.json`).

## Interfaces

### ActionMeasurement

Action group (`action.*`).

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### contactState?

> `optional` **contactState?**: `"open"` \| `"closed"`

State of a contact sensor.

##### motion?

> `optional` **motion?**: [`MotionMeasurement`](#motionmeasurement)

Motion state.

***

### AirMeasurement

Air group (`air.*`).

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### co2?

> `optional` **co2?**: `number`

Concentration of CO2 in the air (ppm).

##### lightIntensity?

> `optional` **lightIntensity?**: `number`

Light intensity (lux).

##### location?

> `optional` **location?**: `"indoor"` \| `"outdoor"`

Whether the measurement was taken indoors or outdoors.

##### pressure?

> `optional` **pressure?**: `number`

Atmospheric pressure (hPa).

##### relativeHumidity?

> `optional` **relativeHumidity?**: `number`

Relative humidity (%).

##### temperature?

> `optional` **temperature?**: `number`

Air temperature (°C).

***

### CategoryInfo

Public description of a category, loaded from `definitions/categories/`.

#### Properties

##### description

> **description**: `string`

One-line description.

##### id

> **id**: `string`

Stable slug (folder/file name).

##### name

> **name**: `string`

Display name.

##### notes?

> `optional` **notes?**: `string`

Authoring notes (units, gotchas).

##### provides

> **provides**: `string`[]

Documented typical optional paths (informational).

##### requires

> **requires**: `string`[]

Dotted paths every member device reports in ≥1 uplink.

***

### DeviceInfo

Public description of a registry device, from its `device.json`.

#### Properties

##### categories

> **categories**: `string`[]

##### device

> **device**: `string`

##### downlink

> **downlink**: `object`

###### decode

> **decode**: `boolean`

###### encode

> **encode**: `boolean`

##### draft?

> `optional` **draft?**: `boolean`

True for a scaffolded-but-not-yet-authored device: the folder, reference
snapshot, provenance, and seeded vectors exist, but `codec.js` is still a
stub. Drafts are hidden from [devices](#devices) by default, are not counted as
"covered" by the sync diff, and the conformance suite skips their
vector/decode checks rather than failing them.

##### name

> **name**: `string`

##### sensors

> **sensors**: `string`[]

##### ttn

> **ttn**: [`TtnProvenance`](#ttnprovenance) \| `null`

TTN provenance, or null for devices with no upstream (e.g. Makerfabs).

##### variantOf

> **variantOf**: `string` \| `null`

`<vendor>/<device>` of the base variant, or null.

##### vendor

> **vendor**: `string`

***

### Measurement

A single normalized reading. Mirrors `definitions/vocabulary.schema.json`.
Datalog/history uplinks place the current reading at the top level and prior
readings in [Measurement.history](#history); each history entry must carry a
`time`.

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### action?

> `optional` **action?**: [`ActionMeasurement`](#actionmeasurement)

##### air?

> `optional` **air?**: [`AirMeasurement`](#airmeasurement)

##### battery?

> `optional` **battery?**: `number`

Battery voltage (V).

##### history?

> `optional` **history?**: [`Measurement`](#measurement)[]

Prior readings for datalog uplinks; each entry must carry `time`.

##### metering?

> `optional` **metering?**: [`MeteringMeasurement`](#meteringmeasurement)

##### position?

> `optional` **position?**: [`PositionMeasurement`](#positionmeasurement)

##### rain?

> `optional` **rain?**: [`RainMeasurement`](#rainmeasurement)

##### soil?

> `optional` **soil?**: [`SoilMeasurement`](#soilmeasurement)

##### time?

> `optional` **time?**: `string`

Date and time of the measurement (RFC3339).

##### water?

> `optional` **water?**: [`WaterMeasurement`](#watermeasurement)

##### wind?

> `optional` **wind?**: [`WindMeasurement`](#windmeasurement)

***

### MeteringMeasurement

Metering group (`metering.*`).

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### water?

> `optional` **water?**: `object`

Water metering.

###### Index Signature

\[`extra`: `string`\]: `unknown`

###### total?

> `optional` **total?**: `number`

Total volume (L).

***

### MissingDevice

A TTN device absent from this module (from [findMissingDevices](#findmissingdevices)).

#### Properties

##### device

> **device**: `string`

##### hasCodec

> **hasCodec**: `boolean`

Whether the upstream entry ships a decoder.

##### hasNormalizedExamples

> **hasNormalizedExamples**: `boolean`

Whether the upstream codec yaml carries `normalizedOutput` examples.

##### name

> **name**: `string`

##### sensors

> **sensors**: `string`[]

##### suggestedCategories

> **suggestedCategories**: `string`[]

Categories inferred from the device's sensors.

##### vendor

> **vendor**: `string`

***

### MotionMeasurement

Motion sub-group (`action.motion.*`).

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### count?

> `optional` **count?**: `number`

Number of motion events (count).

##### detected?

> `optional` **detected?**: `boolean`

Motion detected.

***

### PositionMeasurement

Position group (`position.*`).

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### latitude?

> `optional` **latitude?**: `number`

Horizontal distance from equator (°), -90..90.

##### longitude?

> `optional` **longitude?**: `number`

Vertical distance from prime meridian (°), -180..180.

***

### RainMeasurement

Rain group (`rain.*`).

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### cumulative?

> `optional` **cumulative?**: `number`

Cumulative rainfall (mm).

##### intensity?

> `optional` **intensity?**: `number`

Rainfall intensity (mm/hour).

***

### SoilMeasurement

Soil group (`soil.*`).

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### depth?

> `optional` **depth?**: `number`

Depth of the soil measurement (cm).

##### ec?

> `optional` **ec?**: `number`

Soil electrical conductivity (dS/m).

##### k?

> `optional` **k?**: `number`

Concentration of Potassium in the soil (ppm).

##### moisture?

> `optional` **moisture?**: `number`

Soil moisture (%).

##### n?

> `optional` **n?**: `number`

Concentration of Nitrogen in the soil (ppm).

##### p?

> `optional` **p?**: `number`

Concentration of Phosphorus in the soil (ppm).

##### pH?

> `optional` **pH?**: `number`

Soil pH level (0–14).

##### temperature?

> `optional` **temperature?**: `number`

Soil temperature (°C).

***

### TtnProvenance

Provenance linking a registry device back to its TTN upstream entry.

#### Properties

##### codecFile

> **codecFile**: `string`

Upstream decoder file name (e.g. `lse01.js`).

##### codecId

> **codecId**: `string`

Codec id from the device's firmware reference.

##### codecSha256

> **codecSha256**: `string`

sha256 of the upstream decoder file at authoring time.

##### device

> **device**: `string`

##### referencedAt

> **referencedAt**: `string`

ISO date the upstream codec was referenced.

##### vendor

> **vendor**: `string`

***

### UpstreamDrift

sha256 drift of an upstream reference codec (from [findUpstreamChanges](#findupstreamchanges)).

#### Properties

##### changed

> **changed**: `boolean`

True when the upstream codec changed since authoring.

##### currentSha256

> **currentSha256**: `string` \| `null`

Current upstream sha256, or null if the upstream file is gone.

##### device

> **device**: `string`

##### storedSha256

> **storedSha256**: `string`

sha256 recorded in this module's device.json.

##### vendor

> **vendor**: `string`

***

### ValidationIssue

A single validation failure.

#### Properties

##### message

> **message**: `string`

Human-readable explanation.

##### path

> **path**: `string`

Dotted path to the offending value (e.g. `soil.moisture`).

##### rule

> **rule**: [`ValidationRule`](#validationrule)

Which rule produced the issue.

***

### ValidationResult

Result of [validate](#validate).

#### Properties

##### issues

> **issues**: [`ValidationIssue`](#validationissue)[]

All failures found (empty when valid).

##### valid

> **valid**: `boolean`

True when there are no issues.

***

### WaterMeasurement

Water group (`water.*`).

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### leak?

> `optional` **leak?**: `boolean`

Leak detected.

##### temperature?

> `optional` **temperature?**: [`WaterTemperature`](#watertemperature)

Water temperature readings (°C).

***

### WaterTemperature

Water temperature sub-group (`water.temperature.*`).

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### avg?

> `optional` **avg?**: `number`

Average temperature (°C).

##### current?

> `optional` **current?**: `number`

Current temperature (°C).

##### max?

> `optional` **max?**: `number`

Maximum temperature (°C).

##### min?

> `optional` **min?**: `number`

Minimum temperature (°C).

***

### WindMeasurement

Wind group (`wind.*`).

#### Indexable

> \[`extra`: `string`\]: `unknown`

#### Properties

##### direction?

> `optional` **direction?**: `number`

Wind direction (°, 0 to <360).

##### speed?

> `optional` **speed?**: `number`

Wind speed (m/s).

## Type Aliases

### ValidationRule

> **ValidationRule** = `"schema"` \| `"case-collision"` \| `"reserved-key"` \| `"history-time"`

Why a [ValidationIssue](#validationissue) was raised.

## Variables

### VERSION

> `const` **VERSION**: `"0.1.0"` = `'0.1.0'`

Package version, kept in sync with package.json.

## Functions

### categories()

> **categories**(): [`CategoryInfo`](#categoryinfo)[]

List every category, sorted by id.

#### Returns

[`CategoryInfo`](#categoryinfo)[]

#### Example

```ts
categories().map((c) => c.id); // ['air-quality', 'climate', 'contact', ...]
```

***

### categorySchema()

> **categorySchema**(`id`): `Record`\<`string`, `unknown`\>

A self-contained JSON Schema (2020-12) describing a measurement valid in the
given category. Value bounds are the global vocabulary bounds (identical in
every category); the category's `requires`/`provides` paths are attached as
the non-standard `x-requires`/`x-provides` annotations for introspection.

#### Parameters

##### id

`string`

Category id (e.g. `"soil-monitor"`).

#### Returns

`Record`\<`string`, `unknown`\>

***

### checkForNewDevices()

> **checkForNewDevices**(`opts?`): `Promise`\<[`MissingDevice`](#missingdevice)[]\>

Convenience: refresh the device cache, then diff. Requires the peer.

#### Parameters

##### opts?

###### category?

`string`

###### limit?

`number`

###### vendor?

`string`

#### Returns

`Promise`\<[`MissingDevice`](#missingdevice)[]\>

***

### codecScript()

> **codecScript**(`vendor`, `deviceId`): `string`

Raw `codec.js` text for a device (console-ready). Throws if the device is
unknown, or if it is a draft (scaffolded but not yet authored) — a draft has
only a stub, so callers should treat it as "not available here" and fall back
to the upstream codec.

#### Parameters

##### vendor

`string`

##### deviceId

`string`

#### Returns

`string`

***

### device()

> **device**(`vendor`, `deviceId`): [`DeviceInfo`](#deviceinfo)

Parsed `device.json` for one device. Throws if unknown.

#### Parameters

##### vendor

`string`

##### deviceId

`string`

#### Returns

[`DeviceInfo`](#deviceinfo)

***

### devices()

> **devices**(`opts?`): [`DeviceInfo`](#deviceinfo)[]

List registry devices. Authored devices only by default; pass
`includeDrafts: true` to also include scaffolded-but-unauthored drafts.

#### Parameters

##### opts?

###### category?

`string`

Restrict to devices declaring this category.

###### includeDrafts?

`boolean`

Include `draft: true` devices (default false).

#### Returns

[`DeviceInfo`](#deviceinfo)[]

***

### findMissingDevices()

> **findMissingDevices**(`opts?`): [`MissingDevice`](#missingdevice)[]

List TTN devices not yet covered by this module (joined on `ttn` provenance).

#### Parameters

##### opts?

###### category?

`string`

Keep only devices whose suggested categories include this.

###### limit?

`number`

Cap the number of results returned.

###### vendor?

`string`

Restrict the scan to one upstream vendor.

#### Returns

[`MissingDevice`](#missingdevice)[]

***

### findUpstreamChanges()

> **findUpstreamChanges**(): [`UpstreamDrift`](#upstreamdrift)[]

Detect sha256 drift between each covered device's recorded upstream codec and
the current upstream file. A non-empty result means an upstream codec changed
since it was referenced — re-review the affected normalized codec.

#### Returns

[`UpstreamDrift`](#upstreamdrift)[]

***

### lintCodec()

> **lintCodec**(`source`): `string`[]

Statically lint a `codec.js`. Returns an array of human-readable violations;
an empty array means the codec passes. Checks the SPDX header on the raw
source and banned constructs on a comment/string-stripped copy.

#### Parameters

##### source

`string`

Raw `codec.js` text (e.g. from [codecScript](#codecscript)).

#### Returns

`string`[]

***

### suggestCategories()

> **suggestCategories**(`sensors`): `string`[]

Map a TTN `sensors` list to candidate category ids (see the plan).

#### Parameters

##### sensors

`string`[]

#### Returns

`string`[]

***

### updateDeviceList()

> **updateDeviceList**(): `Promise`\<`string`\>

Download/refresh the TTN device repository via the peer. Returns the cache
path written. Requires the optional peer.

#### Returns

`Promise`\<`string`\>

***

### validate()

> **validate**(`categoryId`, `data`, `opts?`): [`ValidationResult`](#validationresult)

Validate a measurement (or array of measurements) against a category.

Bounds and key legality come from the global vocabulary; the category only
adds its `requires` set, enforced when `opts.requireAll` is true. The default
(`requireAll: false`) keeps fPort-variant, config, and partial uplinks legal.

#### Parameters

##### categoryId

`string`

Category id (e.g. `"soil-monitor"`). Throws if unknown.

##### data

[`Measurement`](#measurement) \| [`Measurement`](#measurement)[]

One measurement or a TTN-style array of measurements.

##### opts?

###### requireAll?

`boolean`

Require every `requires` path to be present.

#### Returns

[`ValidationResult`](#validationresult)
