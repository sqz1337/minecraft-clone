# Minecraft texture source

These texture files were extracted from the official Minecraft Java Edition 26.2
client downloaded through Mojang's version manifest.

- Client SHA-1: `2dc72797acbc1b63fc16a11c4ac393605f453754`
- Scope: local, personal use only
- Namespace preserved from the client.
- Held-item subset: original `models/item/*.json` files and the referenced
  `textures/item/*.png` layers. The runtime resolves the vanilla `generated`
  and `handheld` parents instead of treating `items.png` as a complete model.
- HUD subset: the three modern crosshair attack-indicator sprites.
- Classic sound cache subset: `random/chestclosed.ogg`.

These files are owned by Mojang/Microsoft and should not be redistributed as part
of a public release of this project.
