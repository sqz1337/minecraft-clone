import './style.css'
import { Game } from './core/Game'
import { Settings } from './core/Settings'
import { UI } from './ui/UI'
import { createAtlas } from './gfx/Atlas'
import { createItemSprites } from './gfx/ItemSprites'
import { MinecraftFont } from './ui/MinecraftFont'

const settings = new Settings()
settings.load()

const font = await MinecraftFont.load()
const ui = new UI(settings, font)
const container = document.getElementById('app')!
const [atlas, sprites] = await Promise.all([createAtlas(), createItemSprites()])
new Game(container, ui, settings, atlas, sprites)

ui.showTitle()
