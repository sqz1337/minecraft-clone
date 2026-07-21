import { Chunk } from './Chunk'
import { WorldGen } from './WorldGen'
import type { WorldGenWorkerRequest, WorldGenWorkerResponse } from './WorldGenWorkerProtocol'

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorldGenWorkerRequest>) => void) | null
  postMessage(message: WorldGenWorkerResponse, transfer?: Transferable[]): void
}

const scope = globalThis as unknown as WorkerScope
let generator: WorldGen | null = null

scope.onmessage = (event) => {
  const request = event.data
  if (request.type === 'init') {
    generator = new WorldGen(request.seed, request.version)
    return
  }

  try {
    if (!generator) throw new Error('World generator worker was not initialized')
    const chunk = new Chunk(request.cx, request.cz)
    generator.fillChunk(chunk)
    // Plans are pure data. Priming the main-thread index with them prevents
    // gameplay metadata queries from repeating the expensive terrain probes.
    const structurePlans = [...generator.structurePlansIn(request.cx, request.cz)]
    const response: WorldGenWorkerResponse = {
      type: 'generated',
      id: request.id,
      cx: request.cx,
      cz: request.cz,
      blocks: chunk.blocks.buffer,
      colBiome: chunk.colBiome.buffer,
      colHeight: chunk.colHeight.buffer,
      structurePlans
    }
    scope.postMessage(response, [response.blocks, response.colBiome, response.colHeight])
  } catch (error) {
    scope.postMessage({
      type: 'error',
      id: request.id,
      cx: request.cx,
      cz: request.cz,
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
