import './style.css'
import { Game } from './core/Game'
import { Settings } from './core/Settings'
import { UI } from './ui/UI'
import { createAtlas } from './gfx/Atlas'
import { createItemSprites } from './gfx/ItemSprites'
import { MinecraftFont } from './ui/MinecraftFont'
import { createVanillaHeldItems } from './gfx/VanillaHeldItems'
import { WorldLibrary } from './core/WorldSave'
import { desktopWindow } from './core/Desktop'

const settings = new Settings()
settings.load()
void desktopWindow.fullscreen(settings.fullscreen)

const font = await MinecraftFont.load()
const ui = new UI(settings, font, new WorldLibrary())
const container = document.getElementById('app')!
const [atlas, sprites, heldItems] = await Promise.all([createAtlas(), createItemSprites(), createVanillaHeldItems()])
new Game(container, ui, settings, atlas, sprites, heldItems)

ui.showTitle()
