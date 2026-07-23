import { HOTBAR, B, tileFor, CROSS, RENDER_SHAPE } from '../world/Blocks'
import { ITEMS, durabilityForItem, itemName } from '../world/Items'
import { FURNACE_SMELT_SECONDS, RECIPES, Recipe, recipeIngredients } from '../world/Recipes'
import type { Atlas } from '../gfx/Atlas'
import type { ItemSprites } from '../gfx/ItemSprites'
import { CONTROL_DEFINITIONS, displayKey, type Settings, type QualityName, type GameMode, type ControlAction } from '../core/Settings'
import type { Inventory, ItemStack } from '../player/Inventory'
import type { Crafting, CursorHolder } from '../player/Crafting'
import type { FurnaceState } from '../world/Containers'
import type { MinecraftFont } from './MinecraftFont'
import type { Equipment } from '../player/Equipment'
import { stackDisplayName, type EnchantingState } from '../player/Enchantments'
import { VILLAGER_TRADES } from '../entities/Trades'
import type { VillagerProfession } from '../entities/EntityTypes'
import { WorldLibrary, type WorldSummary } from '../core/WorldSave'
import { el, HudData, SlotButton, SlotHandler, UIScreen } from './UIShared'
import type { UI } from './UI'

type UIConstructor = { prototype: UI }

export function installUIMenus(UIClass: UIConstructor): void {
  const prototype = UIClass.prototype
  prototype.openWorldSelect = async function(this: UI): Promise<void> {
    this.swap(this.worldSelect)
    this.worldList.replaceChildren()
    this.worldEmpty.classList.add('hidden')
    const loading = document.createElement('p')
    loading.className = 'world-loading'
    loading.textContent = 'Loading worlds...'
    this.worldList.append(loading)
    this.worlds = await this.worldLibrary.list()
    if (this.selectedWorldId && !this.worlds.some(world => world.id === this.selectedWorldId)) {
      this.selectedWorldId = null
    }
    if (!this.selectedWorldId) this.selectedWorldId = this.worlds[0]?.id ?? null
    this.renderWorldList()
  }
  prototype.renderWorldList = function(this: UI): void {
    this.worldList.replaceChildren()
    this.worldEmpty.classList.toggle('hidden', this.worlds.length > 0)
    for (const world of this.worlds) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'world-row' + (world.id === this.selectedWorldId ? ' selected' : '')
      row.dataset.worldId = world.id
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(world.id === this.selectedWorldId))
      const date = world.lastPlayed > 0 ? new Date(world.lastPlayed).toLocaleString() : 'Never played'
      row.innerHTML = `<strong></strong><span></span><small></small>`
      row.querySelector('strong')!.textContent = world.name
      const mode = world.gameMode === 'survival' ? 'Survival Mode' : 'Creative Mode'
      row.querySelector('span')!.textContent = `${world.silentHill ? 'Silent Hill · ' : ''}${mode} · ${date}`
      row.querySelector('small')!.textContent = `Seed: ${world.seed}`
      row.addEventListener('click', () => {
        this.selectedWorldId = world.id
        this.renderWorldList()
      })
      row.addEventListener('dblclick', () => this.onEnterWorld(world))
      this.worldList.append(row)
    }
    const hasSelection = this.worlds.some(world => world.id === this.selectedWorldId)
    el<HTMLButtonElement>('btn-play-world').disabled = !hasSelection
    el<HTMLButtonElement>('btn-delete-world').disabled = !hasSelection
  }
  prototype.openCreateWorld = function(this: UI): void {
    const taken = new Set(this.worlds.map(world => world.name.toLowerCase()))
    let name = 'New World'
    for (let index = 2; taken.has(name.toLowerCase()); index++) name = `New World (${index})`
    el<HTMLInputElement>('world-name-input').value = name
    el<HTMLInputElement>('seed-input').value = ''
    el<HTMLSelectElement>('game-mode-select').value = this.settings.lastGameMode
    this.createSilentHill = false
    this.syncSilentHillOption()
    this.updateGameModeDescription()
    this.swap(this.worldCreate)
    el<HTMLInputElement>('world-name-input').focus()
    el<HTMLInputElement>('world-name-input').select()
  }
  prototype.updateGameModeDescription = function(this: UI): void {
    const survival = el<HTMLSelectElement>('game-mode-select').value === 'survival'
    el<HTMLParagraphElement>('game-mode-description').textContent = survival
      ? 'Search for resources, craft, gain levels, health and hunger.'
      : 'Unlimited resources, free flying and instant building.'
  }
  prototype.syncSilentHillOption = function(this: UI): void {
    const button = el<HTMLButtonElement>('btn-world-silent-hill')
    button.textContent = `Silent Hill: ${this.createSilentHill ? 'ON' : 'OFF'}`
    button.setAttribute('aria-pressed', String(this.createSilentHill))
    button.classList.toggle('active-option', this.createSilentHill)
  }
  prototype.createWorld = async function(this: UI): Promise<void> {
    const button = el<HTMLButtonElement>('btn-confirm-create')
    if (button.disabled) return
    button.disabled = true
    button.textContent = 'Creating World...'
    const name = el<HTMLInputElement>('world-name-input').value
    const seed = el<HTMLInputElement>('seed-input').value
    const mode = el<HTMLSelectElement>('game-mode-select').value as GameMode
    try {
      const world = await this.worldLibrary.create(name, seed, mode, this.createSilentHill)
      this.settings.lastSeed = world.seed
      this.settings.lastGameMode = world.gameMode
      this.settings.save()
      this.onEnterWorld(world)
    } finally {
      button.disabled = false
      button.textContent = 'Create New World'
    }
  }
  prototype.showDeleteConfirmation = function(this: UI): void {
    const world = this.worlds.find(candidate => candidate.id === this.selectedWorldId)
    if (!world) return
    el<HTMLParagraphElement>('delete-world-name').textContent = `Are you sure you want to delete “${world.name}”?`
    this.swap(this.deleteWorldConfirm)
  }
  prototype.deleteSelectedWorld = async function(this: UI): Promise<void> {
    const world = this.worlds.find(candidate => candidate.id === this.selectedWorldId)
    if (!world) return
    const button = el<HTMLButtonElement>('btn-confirm-delete')
    button.disabled = true
    button.textContent = 'Deleting...'
    try {
      await this.worldLibrary.delete(world)
      this.selectedWorldId = null
      await this.openWorldSelect()
    } finally {
      button.disabled = false
      button.textContent = 'Delete'
    }
  }
  prototype.showOptions = function(this: UI, origin: 'title' | 'pause'): void {
    this.menuReturn = origin
    this.setMenuBackdrop(origin)
    this.syncSettingsUI()
    this.swap(this.options)
  }
  prototype.closeOptions = function(this: UI): void {
    if (this.menuReturn === 'pause') this.swap(this.pause)
    else this.showTitle()
  }
  prototype.setMenuBackdrop = function(this: UI, origin: 'title' | 'pause'): void {
    for (const screen of [this.options, this.videoSettings, this.soundSettings, this.controls]) {
      screen.classList.toggle('from-pause', origin === 'pause')
    }
  }
  prototype.syncSettingsUI = function(this: UI): void {
    const qualityNames: Record<QualityName, string> = {
      low: 'Fast', medium: 'Balanced', high: 'Fancy', ultra: 'Fabulous'
    }
    const percent = Math.round(this.settings.volume * 100)
    const sensitivity = Math.round(this.settings.mouseSensitivity * 200)
    const fovName = this.settings.fov === 75 ? 'Normal' : String(this.settings.fov)
    el<HTMLInputElement>('opt-volume').value = String(this.settings.volume)
    el<HTMLInputElement>('opt-render').value = String(this.settings.renderDistance)
    el<HTMLInputElement>('opt-fov').value = String(this.settings.fov)
    el<HTMLInputElement>('opt-sensitivity').value = String(this.settings.mouseSensitivity)
    el<HTMLElement>('opt-volume-label').textContent = `Master Volume: ${percent === 0 ? 'OFF' : percent + '%'}`
    el<HTMLElement>('opt-render-label').textContent = `Render Distance: ${this.settings.renderDistance} chunks`
    el<HTMLElement>('opt-fov-label').textContent = `FOV: ${fovName}`
    el<HTMLElement>('opt-sensitivity-label').textContent = `Sensitivity: ${sensitivity}%`
    el<HTMLButtonElement>('btn-graphics').textContent = `Graphics: ${qualityNames[this.settings.quality]}`
    el<HTMLButtonElement>('btn-view-bobbing').textContent = `View Bobbing: ${this.settings.headBob ? 'ON' : 'OFF'}`
    el<HTMLButtonElement>('btn-invert-mouse').textContent = `Invert Mouse: ${this.settings.invertMouse ? 'ON' : 'OFF'}`
    const fullscreenText = `Fullscreen: ${this.settings.fullscreen ? 'ON' : 'OFF'}`
    el<HTMLButtonElement>('btn-fullscreen').textContent = fullscreenText
    el<HTMLButtonElement>('btn-video-fullscreen').textContent = fullscreenText
  }
  prototype.captureRebind = function(this: UI, event: KeyboardEvent): void {
    if (!this.rebindingAction) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.code !== 'Escape') {
      this.settings.setKey(this.rebindingAction, event.code)
      this.onSettingsChanged()
    }
    this.rebindingAction = null
    this.renderControls()
  }
  prototype.renderControls = function(this: UI): void {
    const duplicates = new Set<string>()
    const counts = new Map<string, number>()
    for (const control of CONTROL_DEFINITIONS) {
      const code = this.settings.key(control.id)
      counts.set(code, (counts.get(code) ?? 0) + 1)
    }
    for (const [code, count] of counts) if (count > 1) duplicates.add(code)

    const fragment = document.createDocumentFragment()
    let category = ''
    for (const control of CONTROL_DEFINITIONS) {
      if (control.category !== category) {
        category = control.category
        const heading = document.createElement('h3')
        heading.className = 'controls-category'
        heading.textContent = category
        fragment.append(heading)
      }
      const code = this.settings.key(control.id)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'btn control-binding'
      if (duplicates.has(code)) button.classList.add('conflict')
      if (this.rebindingAction === control.id) button.classList.add('waiting')
      const label = document.createElement('span')
      label.textContent = control.label
      const key = document.createElement('b')
      key.className = 'binding-key'
      key.textContent = this.rebindingAction === control.id ? '> Press a key <' : displayKey(code)
      button.append(label, key)
      button.addEventListener('click', () => {
        this.rebindingAction = control.id
        this.renderControls()
      })
      fragment.append(button)
    }
    this.controlsList.replaceChildren(fragment)
  }
  prototype.showTitle = function(this: UI): void { this.swap(this.title) }
  prototype.showLoading = function(this: UI): void {
    this.loadProgress = 0
    this.swap(this.loading)
    if (this.loadAnimationFrame === null) this.loadAnimationFrame = requestAnimationFrame(time => this.drawLoading(time))
  }
  prototype.showGame = function(this: UI): void { this.swap(null); this.hud.classList.remove('hidden') }
  prototype.showPause = function(this: UI): void { this.pause.classList.remove('hidden') }
  prototype.hidePause = function(this: UI): void { this.pause.classList.add('hidden') }
  prototype.isPauseVisible = function(this: UI): boolean { return !this.pause.classList.contains('hidden') }
  prototype.showInventory = function(this: UI, on: boolean): void {
    this.inventoryScreen.classList.toggle('hidden', !on)
    if (on) this.renderScreen()
    else this.renderCursor()
  }
  prototype.showControls = function(this: UI): void {
    this.setMenuBackdrop(this.menuReturn)
    this.renderControls()
    this.swap(this.controls)
  }
  prototype.closeControls = function(this: UI): void {
    this.rebindingAction = null
    if (this.controlsReturn === 'options') this.swap(this.options)
    else this.closeOptions()
  }
  prototype.swap = function(this: UI, screen: HTMLDivElement | null): void {
    for (const item of [
      this.title, this.worldSelect, this.worldCreate, this.options, this.videoSettings, this.soundSettings,
      this.controls, this.deleteWorldConfirm, this.loading, this.pause
    ]) item.classList.toggle('hidden', item !== screen)
  }
}
