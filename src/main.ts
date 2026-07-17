import './style.css'
import { Game } from './core/Game'
import { Settings } from './core/Settings'
import { UI } from './ui/UI'
import { createAtlas } from './gfx/Atlas'

const settings = new Settings()
settings.load()

const ui = new UI(settings)
const container = document.getElementById('app')!
const atlas = await createAtlas()
new Game(container, ui, settings, atlas)

ui.showTitle()
