import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { WorldGen, BIOME } from './src/world/WorldGen.ts'",
      "export { Chunk } from './src/world/Chunk.ts'",
      "export { B } from './src/world/Blocks.ts'",
      "export { hash2 } from './src/util/math.ts'",
      "export { box, boxesIntersect, boxIntersectsChunk, unionBoxes } from './src/world/structures/Bounds.ts'",
      "export { StructureIndex } from './src/world/structures/StructureIndex.ts'",
      "export { VILLAGE_SPACING, VILLAGE_SEPARATION, VILLAGE_SALT, villageCandidateForRegion, isMineshaftCandidate, generateDungeonCandidates } from './src/world/structures/Generators.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-structures-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const {
  WorldGen, Chunk, B, box, boxesIntersect, boxIntersectsChunk, unionBoxes,
  StructureIndex, hash2, generateDungeonCandidates,
  VILLAGE_SPACING, VILLAGE_SEPARATION, VILLAGE_SALT, villageCandidateForRegion,
  isMineshaftCandidate
} = bundledModule.exports

function local(value) { return (value % 16 + 16) % 16 }

function containsBox(outer, inner) {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY && inner.maxY <= outer.maxY &&
    inner.minZ >= outer.minZ && inner.maxZ <= outer.maxZ
}

function horizontalGap(a, b) {
  const dx = Math.max(0, b.minX - a.maxX - 1, a.minX - b.maxX - 1)
  const dz = Math.max(0, b.minZ - a.maxZ - 1, a.minZ - b.maxZ - 1)
  return dx + dz
}

function findVillage(generator, radius = 18) {
  for (let rx = -radius; rx <= radius; rx++) for (let rz = -radius; rz <= radius; rz++) {
    const plan = generator.villageIn(rx, rz)
    if (plan) return { plan, rx, rz }
  }
  return null
}

function findMineshaft(generator, radius = 80) {
  for (let cx = -radius; cx <= radius; cx++) for (let cz = -radius; cz <= radius; cz++) {
    const plan = generator.mineshaftIn(cx, cz)
    if (plan) return { plan, cx, cz }
  }
  return null
}

test('inclusive 3D bounding boxes clip exact chunk edges', () => {
  const left = box(0, 4, 0, 15, 8, 15)
  const right = box(16, 8, 15, 18, 12, 17)
  assert.equal(boxIntersectsChunk(left, 0, 0), true)
  assert.equal(boxIntersectsChunk(left, 1, 0), false)
  assert.equal(boxIntersectsChunk(right, 0, 0), false)
  assert.equal(boxIntersectsChunk(right, 1, 0), true)
  assert.equal(boxesIntersect(left, right), false)
  assert.deepEqual(unionBoxes([left, right]), box(0, 4, 0, 18, 12, 17))
})

test('village starts use spacing 32, separation 8 and salt 10387312', () => {
  assert.equal(VILLAGE_SPACING, 32)
  assert.equal(VILLAGE_SEPARATION, 8)
  assert.equal(VILLAGE_SALT, 10387312)
  for (const [rx, rz] of [[0, 0], [-1, -1], [17, -23], [-40, 12]]) {
    const first = villageCandidateForRegion(123456, rx, rz)
    const second = villageCandidateForRegion(123456, rx, rz)
    assert.deepEqual(first, second)
    assert.ok(first.cx - rx * 32 >= 0 && first.cx - rx * 32 < 24)
    assert.ok(first.cz - rz * 32 >= 0 && first.cz - rz * 32 < 24)
  }
})

test('accepted village owns recursive roads, intersections and the classic building set', () => {
  const generator = new WorldGen('diff-structure-village')
  const found = findVillage(generator)
  assert.ok(found, 'expected an accepted plains/desert grid candidate')
  const { plan, rx, rz } = found
  const candidate = generator.villageCandidate(rx, rz)
  assert.deepEqual([plan.candidateCx, plan.candidateCz], [candidate.cx, candidate.cz])
  assert.ok(plan.roads.length > 4)
  assert.ok(plan.roads.some(road => road.depth > 1 && road.parentId))
  const kinds = new Set(plan.buildings.map(building => building.kind))
  for (const required of ['well', 'church', 'blacksmith', 'library']) assert.ok(kinds.has(required), required)
  for (const building of plan.buildings.filter(building => building.kind !== 'well')) {
    assert.ok(plan.roads.some(road => road.id === building.parentRoadId), `${building.id} parent road`)
  }
  assert.ok(plan.chests.every(chest => chest.loot === 'village_blacksmith'))
})

test('mineshaft candidate builds a recursive connected room/corridor/crossing/stairs graph', () => {
  const generator = new WorldGen('diff-structure-mineshaft')
  const found = findMineshaft(generator)
  assert.ok(found, 'expected a deterministic distance-qualified 1% candidate')
  const { plan, cx, cz } = found
  assert.equal(isMineshaftCandidate(generator.seedNum, cx, cz), true)
  const kinds = new Set(plan.components.map(part => part.kind))
  for (const required of ['mineshaft_room', 'mineshaft_corridor', 'mineshaft_crossing', 'mineshaft_stairs']) {
    assert.ok(kinds.has(required), required)
  }
  assert.equal(plan.openings.length, plan.components.length - 1)
  const ids = new Set(plan.components.map(part => part.id))
  for (const part of plan.components.slice(1)) assert.ok(ids.has(part.parentId), `${part.id} parent`)

  const opening = plan.openings[0]
  const chunk = new Chunk(Math.floor(opening.minX / 16), Math.floor(opening.minZ / 16))
  generator.fillChunk(chunk)
  for (let x = opening.minX; x <= opening.maxX; x++) for (let z = opening.minZ; z <= opening.maxZ; z++) {
    for (let y = opening.minY; y <= opening.maxY; y++) {
      assert.equal(chunk.get(local(x), y, local(z)), B.AIR, 'connector must physically cross the parent wall')
    }
  }
})

test('strongholds relocate three ring starts and retry until exactly one portal room', () => {
  const generator = new WorldGen('diff-structure-strongholds')
  const plans = generator.strongholds()
  assert.equal(plans.length, 3)
  for (const plan of plans) {
    assert.equal(plan.portalRoomCount, 1)
    assert.equal(plan.components.filter(part => part.kind === 'stronghold_portal').length, 1)
    assert.equal(plan.spawner.mob, 'silverfish')
    assert.equal(plan.framePositions.length, 12)
    assert.ok(plan.generationAttempts >= 1)
    assert.ok(plan.components.some(part => part.depth >= 3 && part.parentId))
    assert.equal(plan.bounds.x0, plan.bounds.minX)
    assert.equal(plan.bounds.y1, plan.bounds.maxY)
    const rawDistance = Math.hypot(plan.relocatedFrom.x, plan.relocatedFrom.z)
    assert.ok(rawDistance >= 640 && rawDistance <= 1152)
    const start = plan.components.find(part => part.kind === 'stronghold_start')
    const startX = Math.floor((start.bounds.minX + start.bounds.maxX) / 2)
    const startZ = Math.floor((start.bounds.minZ + start.bounds.maxZ) / 2)
    assert.ok(Math.hypot(startX - plan.relocatedFrom.x, startZ - plan.relocatedFrom.z) <= 113)
    assert.ok(new Set([1, 2, 3, 4, 5, 6, 8, 9, 10]).has(generator.biomeAt(startX, startZ)))
    const portal = plan.components.find(part => part.kind === 'stronghold_portal')
    assert.equal(containsBox(portal.bounds, box(plan.spawner.x, plan.spawner.y, plan.spawner.z,
      plan.spawner.x, plan.spawner.y, plan.spawner.z)), true)
  }
})

test('every recursive plan has a true union bound, disjoint pieces and adjacent parent edges', () => {
  const generator = new WorldGen('diff-structure-invariants')
  const village = findVillage(generator).plan
  const mine = findMineshaft(generator).plan
  let dungeon = null
  for (let cx = -8; cx <= 8 && !dungeon; cx++) for (let cz = -8; cz <= 8 && !dungeon; cz++) {
    dungeon = generator.dungeonIn(cx, cz)
  }
  assert.ok(dungeon)
  const plans = [village, mine, dungeon, ...generator.strongholds()]
  for (const plan of plans) {
    assert.deepEqual(plan.bounds, unionBoxes(plan.components.map(part => part.bounds)), `${plan.id} union`)
    const ids = new Map(plan.components.map(part => [part.id, part]))
    for (const part of plan.components) {
      assert.ok(containsBox(plan.bounds, part.bounds), `${plan.id}/${part.id} contained`)
      if (!part.parentId) continue
      const parent = ids.get(part.parentId)
      assert.ok(parent, `${plan.id}/${part.id} missing parent`)
      assert.ok(horizontalGap(parent.bounds, part.bounds) <= 1, `${plan.id}/${part.id} detached`)
    }
    for (let a = 0; a < plan.components.length; a++) for (let b = a + 1; b < plan.components.length; b++) {
      assert.equal(boxesIntersect(plan.components[a].bounds, plan.components[b].bounds), false,
        `${plan.id}: ${plan.components[a].id} intersects ${plan.components[b].id}`)
    }
  }
})

test('all accepted dungeon attempts expose exact post-carver validation and never overlap', () => {
  const generator = new WorldGen('diff-structure-dungeons')
  const found = []
  for (let cx = -8; cx <= 8 && found.length === 0; cx++) for (let cz = -8; cz <= 8 && found.length === 0; cz++) {
    found.push(...generator.dungeonsIn(cx, cz))
  }
  assert.ok(found.length >= 1, 'expected a room accepted by raw cave terrain')
  for (const plan of found) {
    assert.ok(plan.attempt >= 0 && plan.attempt < 8)
    assert.equal(plan.validation.solidFloor, true)
    assert.equal(plan.validation.solidCeiling, true)
    assert.ok(plan.validation.entranceCount >= 1 && plan.validation.entranceCount <= 5)
  }
  for (let a = 0; a < found.length; a++) for (let b = a + 1; b < found.length; b++) {
    assert.equal(boxesIntersect(found[a].bounds, found[b].bounds), false)
  }
})

test('dungeon Y attempts sample the full world height before terrain rejection', () => {
  const solidSamples = []
  const rejectingTerrain = {
    baseBlockAt() { return B.STONE },
    biomeAt() { return 2 },
    columnInfo() { return { height: 18, biome: 2 } },
    structureBlockAt() { return B.STONE },
    structureSolidAt(_x, y) { solidSamples.push(y); return true }
  }
  generateDungeonCandidates(0x5124, 3, -7, rejectingTerrain)
  assert.ok(solidSamples.some(y => y > 32), 'attempt heights must not be capped by the local surface')
  assert.ok(solidSamples.every(y => y >= 0 && y < 128))
})

test('global dungeon arbitration removes overlaps across neighbouring source chunks', () => {
  const terrain = {
    baseBlockAt() { return B.STONE },
    biomeAt() { return 2 },
    columnInfo() { return { height: 64, biome: 2 } },
    structureSolidAt(_x, y) { return y >= 0 && y < 128 },
    structureBlockAt(x, _y, z) { return hash2(x, z, 0xc411) % 7 === 0 ? B.AIR : B.STONE }
  }
  let proof = null
  for (let seed = 1; seed <= 64 && !proof; seed++) {
    const raw = []
    for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) {
      raw.push(...generateDungeonCandidates(seed, cx, cz, terrain))
    }
    const crossSourceOverlap = raw.some((plan, index) => raw.slice(index + 1).some(other =>
      (plan.startCx !== other.startCx || plan.startCz !== other.startCz) && boxesIntersect(plan.bounds, other.bounds)))
    if (!crossSourceOverlap) continue
    const index = new StructureIndex(seed, terrain)
    const accepted = []
    for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) accepted.push(...index.dungeonsIn(cx, cz))
    proof = { accepted, crossSourceOverlap }
  }
  assert.ok(proof?.crossSourceOverlap, 'fixture must contain competing neighbouring starts')
  assert.ok(new Set(proof.accepted.map(plan => `${plan.startCx},${plan.startCz}`)).size > 1)
  for (let a = 0; a < proof.accepted.length; a++) for (let b = a + 1; b < proof.accepted.length; b++) {
    assert.equal(boxesIntersect(proof.accepted[a].bounds, proof.accepted[b].bounds), false,
      `${proof.accepted[a].id} overlaps ${proof.accepted[b].id}`)
  }
})

test('destination stamping and metadata are independent of query/generation order', () => {
  const first = new WorldGen('diff-structure-order')
  const stronghold = first.strongholds()[0]
  const chest = stronghold.chests[0]
  const cx = Math.floor(chest.x / 16), cz = Math.floor(chest.z / 16)
  first.structurePlansIn(cx + 1, cz)
  first.structureChestsIn(cx - 1, cz)
  const afterQueries = new Chunk(cx, cz)
  first.fillChunk(afterQueries)

  const second = new WorldGen('diff-structure-order')
  const direct = new Chunk(cx, cz)
  second.fillChunk(direct)
  assert.deepEqual(afterQueries.blocks, direct.blocks)
  assert.ok(second.structurePlansIn(cx, cz).some(plan => plan.id === stronghold.id))
  assert.ok(second.structureChestsIn(cx, cz).some(candidate =>
    candidate.x === chest.x && candidate.y === chest.y && candidate.z === chest.z))
  assert.equal(direct.get(local(chest.x), chest.y, local(chest.z)), B.CHEST)
})

test('portal spawner metadata and stamping are silverfish end-to-end', () => {
  const generator = new WorldGen('diff-structure-spawner')
  const plan = generator.strongholds()[0]
  const { spawner } = plan
  const cx = Math.floor(spawner.x / 16), cz = Math.floor(spawner.z / 16)
  const chunk = new Chunk(cx, cz)
  generator.fillChunk(chunk)
  assert.equal(chunk.get(local(spawner.x), spawner.y, local(spawner.z)), B.SPAWNER)
  assert.ok(generator.structureSpawnersNear(spawner.x, spawner.z, 1).some(candidate =>
    candidate.x === spawner.x && candidate.y === spawner.y && candidate.z === spawner.z &&
    candidate.mob === 'silverfish'))
})

test('a cross-chunk component is indexed and stamped in every intersected destination', () => {
  const generator = new WorldGen('diff-structure-cross-chunk')
  const plan = generator.strongholds()[0]
  const part = plan.components.find(candidate =>
    Math.floor(candidate.bounds.minX / 16) !== Math.floor(candidate.bounds.maxX / 16) ||
    Math.floor(candidate.bounds.minZ / 16) !== Math.floor(candidate.bounds.maxZ / 16))
  assert.ok(part, 'expected a component crossing a chunk boundary')
  const structural = new Set([B.STONE_BRICK, B.STONE_BRICK_MOSSY, B.STONE_BRICK_CRACKED, B.END_PORTAL_FRAME])
  for (let cx = Math.floor(part.bounds.minX / 16); cx <= Math.floor(part.bounds.maxX / 16); cx++) {
    for (let cz = Math.floor(part.bounds.minZ / 16); cz <= Math.floor(part.bounds.maxZ / 16); cz++) {
      assert.ok(generator.structurePlansIn(cx, cz).some(candidate => candidate.id === plan.id))
      const chunk = new Chunk(cx, cz)
      generator.fillChunk(chunk)
      let stamped = false
      const minX = Math.max(part.bounds.minX, cx * 16), maxX = Math.min(part.bounds.maxX, cx * 16 + 15)
      const minZ = Math.max(part.bounds.minZ, cz * 16), maxZ = Math.min(part.bounds.maxZ, cz * 16 + 15)
      for (let x = minX; x <= maxX && !stamped; x++) for (let z = minZ; z <= maxZ && !stamped; z++) {
        for (let y = part.bounds.minY; y <= part.bounds.maxY; y++) {
          if (structural.has(chunk.get(local(x), y, local(z)))) { stamped = true; break }
        }
      }
      assert.equal(stamped, true, `${plan.id} missing stamp in ${cx},${cz}`)
    }
  }
})
