# Отличия Realmcraft от Minecraft Java 1.2.4

Дата аудита: 20 июля 2026 года.

## Область и методика

За эталон взята **Minecraft Java Edition 1.2.4**. Проверялись текущие исходники
проекта, а поведение оригинала — по официальному клиентскому JAR 1.2.4 и его
декомпиляции. Папка с распакованным Minecraft 1.0 использовалась как
дополнительная проверка, но выводы ниже относятся именно к 1.2.4.

Официальный JAR 1.2.4:
`https://launcher.mojang.com/v1/objects/ad6d1fe7455857269d4185cb8f24e62cc0241aaf/client.jar`.
Имена obfuscated-классов восстанавливались по mappings MCPHackers; исходный код
Minecraft в репозиторий не копировался.

Это сравнение **логики**, а не только внешнего сходства. Совпадение высоты чанка,
формы дерева или числа биомов не означает алгоритмической совместимости.

## Краткий вывод

| Подсистема | Вердикт | Что совпадает | Главное отличие |
|---|---|---|---|
| Рельеф и seed | Не совпадает | Чанк 16×16×128, шумовой рельеф | Другие PRNG, шумы, порядок генерации и уровень моря |
| Биомы | Не совпадает | Есть большинство узнаваемых типов 1.2 | Вместо vanilla `GenLayer` — пороги собственных temperature/moisture noises |
| Пещеры | Не совпадает | Подземные полости и лава внизу | Сплошной 3D noise вместо рекурсивных tunnel carvers; нет ravines |
| Деревни | Частично визуально | Plains/desert, колодец, дома, фермы | Иные spacing и планировка; нет дорог и полного набора компонентов |
| Шахты/крепости/dungeons | Частично визуально | Узнаваемые блоки и комнаты | Все генераторы существенно упрощены |
| Спавн мобов | Не совпадает | Свет ≤7, минимум 24 блока для hostile | Другие cap/радиус/веса; неполная проверка hitbox и площадки |
| Навигация и восприятие | Не совпадает | Есть wander/chase и несколько LOS-проверок | Нет pathfinding и общей системы целей; игрок выбирается сквозь стены |
| Enderman | Не совпадает | Взгляд, телепорт, перенос блока, вода наносит вред | Взгляд работает сквозь стены; нет pumpkin/rain/daylight и vanilla-телепортации |

Итого: проект сейчас воспроизводит **темы и отдельные правила** Minecraft, но не
его world generator и не его AI. Одинаковый seed не должен давать одинаковый мир.

## Критическая причина наблюдения через X-ray

Описанное поведение зомби подтверждается кодом и состоит из нескольких проблем.

1. В [`hostileAi`](src/entities/EntityManager.ts#L623) любой hostile становится
   агрессивным только по 3D-расстоянию: `distance <= followRange`. Для zombie это
   22 блока, но общий механизм тот же для остальных мобов. Проверки видимости при
   выборе игрока нет.
2. После этого [`steer`](src/entities/EntityManager.ts#L735) каждый тик направляет
   скорость прямо на X/Z игрока. Он не строит путь, не знает высоту цели, не ищет
   обход и потому смотрит в сторону игрока и упирается в стену.
3. LOS вызывается только в частных действиях: перед взрывом creeper и выстрелом
   skeleton. Это не отменяет уже начавшееся преследование.
4. У enderman проверка взгляда в строках
   [`631–638`](src/entities/EntityManager.ts#L631) использует только scalar product.
   Стена и надетая тыква не проверяются, поэтому angry state включается сквозь
   породу.

В vanilla 1.2.4 обычные hostile-задачи выбирают ближайшего игрока в радиусе 16
блоков с обязательным line of sight. `EntitySenses` кэширует результат ray trace,
а `EntityAITarget` после потери видимости держит цель не бесконечно, а примерно
до 60 ticks. `PathNavigate` строит и проходит путь по узлам. Поэтому зомби может
помнить недавно увиденного игрока, но не должен впервые обнаружить его через
40 блоков породы и бесконечно давить в стену.

Часть фразы «находятся в блоках» объясняется отдельно:

- центральная точка cave-spawn проверяет пол и только два air-блока;
- участники группы получают смещение X/Z, но для них пол повторно не проверяется;
- не проверяется полный AABB, поэтому особенно enderman высотой 2.9 и широкий
  spider могут пересекать третий/соседний блок;
- [`spawn`](src/entities/EntityManager.ts#L200) сам по себе collision не запрещает;
- [`resolveEmbedded`](src/entities/EntityManager.ts#L902) затем пытается вытолкнуть
  моба, а при неудаче переносит его на верхний solid block колонки;
- у dungeon-spawner также проверяются лишь пол и два блока воздуха
  ([`Game.ts`](src/core/Game.ts#L1279)).

Это две независимые ошибки: исправление LOS не исправит появление внутри блоков,
а строгая проверка spawn volume не исправит «видение» сквозь стены.

## 1. Мир и биомы

### Базовый terrain

**Realmcraft.** [`WorldGen.columnInfo`](src/world/WorldGen.ts#L177) сначала получает
высоту одной колонки из собственных Simplex/FBM/ridged noises, затем вырезает
реки, после чего выбирает биом по температуре, влажности и высоте. Мир фактически
является heightmap с деталями и последующим cave carving.

**Vanilla 1.2.4.** `ChunkProviderGenerate` строит 3D density field из нескольких
octave noises, интерполирует его внутри чанка, а biome temperature/rainfall
участвуют в сглаживании плотности. Это не одна высота на X/Z. Биомная карта
поступает из отдельной цепочки `GenLayer` с zoom/island/edge/river/hills слоями.

Различия:

- `xmur3` + `SimplexNoise` и vanilla `java.util.Random` + octave generators дают
  полностью разные результаты для любого seed;
- море в проекте находится на Y=40
  ([`SEA_LEVEL`](src/world/WorldGen.ts#L6)), в vanilla — около Y=63;
- высота мира 128 и размер чанка 16×16 совпадают с эпохой 1.2.4;
- проект кэширует независимый результат колонки; vanilla генерирует связанную 3D
  плотность чанка и затем заменяет surface blocks;
- собственное вырезание рек до sea level не совпадает с river layer vanilla;
- mushroom island поднимается отдельным special-noise, а не biome-layer pipeline;
- bedrock здесь всегда занимает 2–3 нижних слоя (`y <= 1 или 2`), у vanilla
  неровная толщина определяется отдельным случайным тестом примерно в нижних
  пяти слоях;
- отдельной генерации water/lava lakes нет. В 1.2.4 population делает water lake
  примерно в 1/4 чанков и lava lake примерно в 1/8 с дополнительными условиями.

### Набор и размещение биомов

Проект хранит 12 значений: ocean, beach, plains, forest, desert, mountain, snow,
river, taiga, swamp, jungle и mushroom. Это хорошее тематическое покрытие, но оно
не эквивалентно списку и вариантам 1.2.4. В частности, несколько vanilla-вариантов
сведены в общий `SNOW`/`MOUNTAIN`, а biome IDs проекта собственные.

Границы отличаются принципиально:

- в Realmcraft это локальный каскад `if` по temperature/moisture/height;
- в vanilla связность островов, океанов, рек, снежных зон и увеличение масштаба
  определяются последовательностью слоёв;
- vanilla сглаживает влияние соседних биомов на terrain; в проекте высота и
  название биома выводятся из тех же локальных noises без такого 5×5 blending;
- распределение деревьев — вероятность на каждую колонку
  ([`treeAt`](src/world/WorldGen.ts#L267)), а vanilla использует biome decorator и
  генераторы с числом попыток на чанк;
- jungle tree упрощён до одного ствола; нет полной логики giant jungle trees,
  ветвей, vines/cocoa. Swamp tree также не повторяет vanilla vines;
- surface material выбирается простым правилом на биом. Vanilla добавляет
  шумовую толщину top/filler и biome-specific replacement.

### Руды и декорации

В [`ORE_DEFS`](src/world/WorldGen.ts#L60) есть только coal, iron, gold и diamond.
Для 1.2.4 отсутствуют как минимум redstone и lapis generation. Число попыток,
высотные диапазоны и размер жил также отличаются; собственная stamp-геометрия не
совпадает с `WorldGenMinable` (последовательность перекрывающихся ellipsoids).

Трава, цветы, грибы и тростник ставятся независимыми hash-шансами по колонкам.
Vanilla запускает biome decorator после terrain/mapgen и использует наборы
попыток на чанк. Поэтому плотность, clusters, корреляция объектов и потребление
PRNG не совпадают.

## 2. Пещеры и структуры

### Пещеры

[`fillChunk`](src/world/WorldGen.ts#L354) вырезает блок, когда два 3D Simplex
значения одновременно близки к нулю. Колонки под водой вообще пропускаются,
верх тоннеля обычно ограничен `surface - 7`, а air на Y=3..10 превращается в lava.

Vanilla `MapGenCaves` создаёт редкие начальные точки и рекурсивные извивающиеся
тоннели/комнаты. Тоннель меняет yaw, pitch и радиус, может разделиться на две ветви,
обрабатывает соседние чанки и локально прекращает carving при обнаружении воды.
Ниже Y=10 вырезаемое пространство заполняется lava.

Следствия:

- характер сетки, частота, ширина, развилки и entrances не совпадают;
- blanket-запрет пещер под water columns заметно отличается от локальной защиты
  от затопления vanilla;
- в проекте нет отдельного `MapGenRavine`, присутствующего в 1.2.4;
- deep lava сходна по намерению, но не по форме и последовательности генерации.

### Dungeons

Проект даёт чанку фиксированный 7% шанс ровно одного плана на Y=12..38
([`computeDungeon`](src/world/WorldGen.ts#L680)). Комната 7×7/9×9 узнаваема,
mob weights 50% zombie / 25% skeleton / 25% spider совпадают, chest — один и с
35% шансом второй.

Vanilla делает 8 placement attempts на чанк на случайной высоте. Генератор
принимает комнату только при solid floor/ceiling и 1–5 двухблочных входах, после
чего делает до двух попыток поставить chest у стены. Текущий план не валидирует
эти условия до создания и потому может появляться без естественно подходящей
пещеры или с другой связностью.

### Заброшенные шахты

Проект делит мир на регионы 8×8 chunks и даёт региону 32% шанс. План — 8–14
чередующихся прямых corridor segments, иногда rails и chest
([`computeMineshaft`](src/world/WorldGen.ts#L750)).

Vanilla mapgen использует примерно 1% chance от candidate chunk с дополнительным
условием расстояния от origin и рекурсивно строит room, corridors, crossings и
stairs. В проекте нет стартовой dirt-room, crossings, stairs, cobweb clusters и
cave-spider spawners. Размер, частота и topology не совпадают.

### Strongholds

Обе версии создают три strongholds примерно кольцом вокруг origin. Диапазон
Realmcraft 560–1040 blocks близок к vanilla 1.2.4 (приблизительно 640–1152), но:

- vanilla переносит candidate к подходящему biome в радиусе поиска; проект нет;
- проект всегда строит один фиксированный corridor + storage + library + portal
  room на Y=18 ([`computeStronghold`](src/world/WorldGen.ts#L856));
- vanilla рекурсивно выбирает компоненты, направления, лестницы, двери, prisons,
  libraries и повторяет start, пока не существует portal room;
- в portal room проекта стоит **zombie spawner**
  ([строка 899](src/world/WorldGen.ts#L899)); в vanilla там silverfish spawner;
- отсутствуют silverfish как entity, eyes в frames и полная логика активации
  портала.

### Деревни

Проект использует регион 16×16 chunks и шанс 24%, затем ставит 4–6 зданий вокруг
колодца ([`computeVillage`](src/world/WorldGen.ts#L952)). Plains/desert совпадают с
допустимыми биомами vanilla 1.2.4.

Vanilla использует сетку с spacing 32 chunks, separation 8 и salt `10387312`,
после чего рекурсивно собирает roads и building components от start piece.
Текущие отличия:

- нет дорожного графа и проверки component intersections;
- нет полного набора church, blacksmith, library, huts и соответствующих форм;
- дома размещаются радиально, а не вдоль roads;
- chest добавляется в обычный/large house; в vanilla значимый village loot chest
  связан прежде всего с blacksmith;
- жители заданы готовыми точками, а не создаются компонентами по их правилам;
- structures штампуются последними и напрямую режут terrain/trees. Vanilla
  согласует starts/components с mapgen/population и bounding boxes.

## 3. Общая система мобов

### Natural spawn и despawn

Realmcraft раз в несколько секунд делает восемь попыток в кольце 28–76 blocks от
игрока ([`tryNaturalSpawn`](src/entities/EntityManager.ts#L1008)). Caps фиксированы:
24 passive и 32 hostile. Виды внутри списка почти равновероятны.

Vanilla 1.2.4 обходит eligible chunks вокруг каждого игрока (радиус 8 chunks),
масштабирует category caps примерно от monster 70, creature 15, water 5 и ambient
15 и использует weighted biome spawn lists, pack size и индивидуальный
`getCanSpawnHere`. Spawn point должен быть дальше 24 blocks и от игрока, и от
world spawn. Hard despawn обычно происходит дальше 128 blocks; после времени без
игрока возможен random despawn дальше 32.

Текущие расхождения:

- despawn distance 160 и считается только горизонтально;
- active area — 6 chunks только по X/Z;
- slime выбирается как обычный biome mob, хотя vanilla slime появляется в
  специальных slime chunks ниже Y=40 (с дополнительным случайным тестом);
- snow запрещает spider, forest запрещает slime — таких правил vanilla нет;
- zombie/skeleton получают group 1–3, остальные только 1; vanilla использует
  per-entity pack rules и веса;
- passive в snow/taiga всегда sheep, остальные четыре вида равновероятны;
- отсутствует полная проверка solid/liquid/AABB/full entity height и пригодности
  каждого смещённого pack member;
- отсутствуют многие biome-specific spawn lists и виды.

### Восприятие, цели и pathfinding

В проекте у entity одна точка `goalX/goalZ`. Это не path. `steer` двигает напрямую,
пытаясь прыгнуть через обнаруженный впереди блок; spider получает вертикальный
импульс при любом препятствии.

Vanilla использует scheduler приоритетных `EntityAI*` tasks, `EntitySenses`,
target continuation rules и `PathNavigate`. Путь пересчитывается, проходит по
nodes, учитывает collision, ground, воду и в специальных задачах двери. Есть
stuck detection. Из-за отсутствия этого слоя в Realmcraft все мобы:

- не обходят стены и ямы осмысленно;
- игнорируют разницу Y при выборе направления;
- не разделяют «увидел», «помнит», «достижим» и «атакует»;
- поворачиваются к недоступной цели сквозь стену;
- используют почти одинаковый wander/chase независимо от вида.

## 4. Животные и жители

### Общая passive AI

В vanilla pig/cow/chicken/sheep имеют ordered tasks: swimming, panic, mate,
temptation, follow parent, wander, watch player и idle look; sheep дополнительно
eat grass. Каждая задача использует navigation и собственные условия.

Realmcraft реализует это одним `if/else` в
[`ai`](src/entities/EntityManager.ts#L545): panic → mate → held-item temptation →
random goal. Различия:

- panic всегда бежит строго от текущего игрока, даже если ударил другой моб; не
  ищется случайная достижимая точка;
- temptation не требует пути/видимости и не имеет vanilla-реакции на резкое
  движение игрока;
- mate идёт напрямую, а breeding срабатывает без примерно 60-tick courtship;
- follow-parent отсутствует;
- watch-player и idle-look как отдельные состояния отсутствуют;
- swimming task отсутствует;
- baby duration 20 min, love 30 s и breeding cooldown 5 min по реальному времени
  близки к vanilla.

### Pig, cow и mooshroom

- Общие wheat temptation/breeding близки эпохе 1.2.4.
- У pig отсутствуют saddle и riding. В самой 1.2.4 игрок мог ехать на осёдланной
  свинье, но ещё не мог нормально управлять ею carrot-on-a-stick.
- Cow milking отсутствует либо не относится к entity AI в этом менеджере.
- Mooshroom имеет общий cow-like AI, но уникальные bowl-mushroom-stew, shearing
  into cow и связанные interactions не представлены здесь.

### Sheep

- Shearing и regrowth через поедание травы частично реализованы.
- В vanilla sheep может запускать eat-grass task не только когда уже sheared;
  действие также ускоряет взросление детёныша. Проект пробует есть только у
  взрослой остриженной sheep с таймером 4–10 s.
- Проект выдаёт raw mutton ([definition](src/entities/EntityManager.ts#L55)); в Java
  1.2.4 mutton ещё не существовало.
- Нет полного набора wool colors, наследования цвета и vanilla drop rules.

### Chicken

- Egg timer 5–10 min совпадает по масштабу с vanilla.
- Нет отдельной flutter/fall motion логики chicken.
- Остальная AI сведена к общему passive steering.

### Villager

Текущий villager только блуждает в радиусе home и после урона бежит прямо от
игрока ([`villagerAi`](src/entities/EntityManager.ts#L600)). Vanilla 1.2.4 имеет
avoid zombie, move indoors, restrict/open doors, return to village restriction,
socialize/mate, watch entities и village-aware movement. Поэтому жители проекта
не понимают дома, двери, ночь, деревню и угрозы.

Торговля в проекте — фиксированные списки. Trading был добавлен в Java 1.3.1,
поэтому это осознанная механика более новой версии, а не совпадение с 1.2.4.

## 5. Агрессивные мобы

### Общие правила

Zombie, skeleton, creeper и стандартная target-задача vanilla ищут игрока примерно
в 16 blocks и обычно требуют sight. В проекте ranges различаются от 20 до 28,
а sight при acquisition отсутствует. Revenge target также преследуется прямым
steering без LOS/path.

### Zombie

Vanilla 1.2.4: swim, break wooden door, melee player, melee villager, move through
village/restriction, wander, watch; targets — attacker, visible player в 16 blocks
и villager. Проект:

- не ломает двери;
- не выбирает villager целью;
- обнаруживает игрока сквозь блоки в 22 blocks;
- не строит путь и непрерывно давит в стену;
- daylight burning реализован частично и отключается в воде, что близко к
  оригиналу, но helmet/точные brightness/random checks отсутствуют.

### Skeleton

Vanilla 1.2.4 идёт по path, прекращает сближение после устойчивой видимости на
дистанции до 10 blocks и выпускает стрелу каждые 60 ticks. Проект стреляет на
4–15 blocks примерно каждые 1.55–2 s и искусственно strafes. Это быстрее, дальше
и по поведению ближе к более современному skeleton, но acquisition всё равно
происходит сквозь стену.

### Creeper

Fuse 1.5 s и explosion radius 3 у обычного creeper близки к vanilla. Перед
надуванием проект требует LOS и расстояние <3.2, однако creeper до этого уже
преследует невидимого игрока. В vanilla swell task удерживает состояние при
близкой цели, прекращает его при >7 blocks или потере sight; navigation и target
acquisition также полноценные. В проекте нет charged creeper/lightning state и
удвоенной силы 6.

### Spider

Vanilla проверяет **локальную brightness**: в ярком месте может не приобрести или
случайно потерять цель; умеет wall climbing и иногда leap-атаку на средней
дистанции. Проект использует глобальный `skyDarkness`, не локальный свет, а climb
заменён вертикальным импульсом при любом препятствии. Leap attack отсутствует.
Запрет natural spider spawn в snow biome не соответствует vanilla.

### Slime

Vanilla slime:

- появляется преимущественно по slime-chunk формуле ниже Y=40;
- имеет размеры 1, 2 и 4, здоровье `size²`, урон и jump delay от размера;
- перемещается отдельными прыжками, чаще прыгая рядом с целью;
- большой распадается на 2–4 меньших, пока не дойдёт до harmless size 1.

В проекте slime — обычный непрерывно идущий hostile; есть только normal scale 1
и small 0.5. Большой создаёт 2–3 small напрямую, без medium generation. Spawn,
movement, health/damage ladder, split count и drops поэтому не совпадают.

### Enderman

Это второе место с критическим расхождением.

**Взгляд и aggro:**

- проект: dot product >0.985, distance <28, без LOS, без pumpkin, сразу 30 s anger;
- vanilla: dynamic angular threshold `1 - 0.025 / distance`, обязательный
  `canEntityBeSeen`, pumpkin helmet блокирует реакцию; требуется несколько
  последовательных проверок перед выбором цели;
- vanilla ищет игрока существенно дальше (до 64 blocks), но не сквозь стены;
- vanilla теряет/меняет состояние из-за daylight, rain/water и телепортаций;
  проект в основном держит таймер.

**Телепорт:**

- проект делает до 12 попыток примерно в пределах ±12 X/Z и небольшого диапазона
  Y;
- vanilla random teleport покрывает около ±32 по каждой оси, валидирует collision
  и liquid; имеет отдельный направленный teleport к далёкой цели;
- при пристальном взгляде с близкого расстояния vanilla пытается телепортироваться
  от игрока; при далёкой цели после задержки — к нему;
- projectile в vanilla вызывает до 64 teleport attempts и обычно позволяет
  избежать урона; проект даёт лишь 50% шанс одной попытки.

**Перенос блоков:**

- проект берёт только grass/dirt/sand/gravel и всегда обращается к
  `topSolidY(x,z)`. Enderman в шахте поэтому может менять поверхность над собой;
- vanilla выбирает блок в небольшом 3D-объёме возле самого enderman, имеет более
  широкий allowlist и проверяет опору/свободное место при установке;
- текущий перенос блока делает entity persistent, что дополнительно меняет
  despawn относительно обычного enderman.

## 6. Отсутствующие мобы и связанные механики

Текущий список entity — pig, cow, sheep, chicken, mooshroom, villager, zombie,
skeleton, spider, creeper, slime и enderman
([`EntityTypes.ts`](src/entities/EntityTypes.ts#L1)). Для полного Overworld-среза
1.2.4 отсутствуют, среди прочих: wolf, squid, ocelot, cave spider, silverfish,
iron golem и snow golem. Поэтому нельзя считать совпавшими:

- tame/follow/sit/pack retaliation wolves;
- aquatic spawn/swimming squid;
- ocelot stalking/fleeing/taming и отпугивание creeper;
- cave-spider poison и mineshaft spawners;
- silverfish block hiding/call-for-help и stronghold spawner;
- village population defense и создание iron golem.

Nether-мобы и boss/End mechanics в этот аудит не включались, так как в текущем
менеджере нет соответствующих измерений и типов.

## 7. Рекомендуемый порядок сближения с vanilla

### P0 — исправить наблюдаемые баги

1. Ввести `canAcquireTarget`: range + LOS + допустимый target; не вызывать его
   каждый frame как безусловный `distance <= followRange`.
2. Хранить target ID, `lastSeenAt/lastSeenPosition` и сбрасывать цель после ~60
   unseen ticks; поворачиваться к последней видимой точке, не к live position.
3. Для enderman добавить LOS, pumpkin check и пятишаговое подтверждение взгляда.
4. Создать единую `canSpawnEntity(kind,x,y,z)`: полный AABB, solid floor, весь
   headroom, отсутствие liquid/collision, правила конкретного вида. Вызывать её
   для каждого pack member, structure spawner и load/restore.

### P1 — навигационный фундамент

5. Добавить grid/A* pathfinding с допустимыми step, fall, door, water nodes;
   ограничить пересчёт пути и добавить stuck detection.
6. Разделить target selection, target continuation, navigation и attack action.
7. Перевести mob caps/spawn на eligible chunks, weighted spawn entries и pack
   validation. Slime вынести в специальное правило.

### P2 — поведение видов

8. Реализовать zombie door/villager tasks; skeleton vanilla ranged cadence;
   spider local-light/climb/leap; slime hop/size chain; полный enderman state.
9. Перевести passive animals на task scheduler: panic source, tempt LOS/path,
   follow parent, mate delay, swim, watch/idle; отдельно sheep/chicken traits.
10. Добавить village/door graph и villager schedule/avoidance.

### P3 — генерация мира

11. Сначала выбрать цель: только «похоже на beta/1.2» или точная 1.2.4 seed
    compatibility. Второй вариант требует отдельного порта Java PRNG,
    `GenLayer`, octave density generator и точного порядка population calls.
    Думаю, что порт и seed compatibility делать не нужно, главное чтобы было очень похоже.
12. Независимо от seed compatibility заменить caves на chunk-crossing recursive
    carvers, добавить ravines и lakes.
13. Перенести structures на starts + recursive components + bounding boxes;
    исправить spacing и portal-room spawner.
14. Восстановить biome decorators, все руды 1.2.4, weighted vegetation и полные
    tree generators.


Готово
P0.1 — выбор цели учитывает дальность, LOS и допустимый тип цели.

P0.2 — добавлена память цели примерно на 60 тиков и движение к последней видимой позиции.

P0.3 — Enderman требует пять проверок взгляда, LOS и учитывает тыкву.

P0.4 — единая проверка полного AABB при natural spawn, spawner, загрузке, размножении и разделении slime.

P1.5 — A* pathfinding с обходом стен, высотой сущности, шагами, падением, водой, лавой, дверями и stuck detection.

P1.6 — разделены выбор цели, продолжение преследования, навигация и атака.

P1.7 — eligible chunks, масштабируемые caps, weighted biome lists, pack spawning, despawn и отдельное правило slime chunks.

P2.8 — исправлены Zombie, Skeleton, Spider, Slime и Enderman; добавлены двери и Silverfish.

P2.9 — passive task scheduler: swim, panic, mating, temptation, follow parent, wander, watch/idle; трава для овец и flutter/яйца кур.

P2.10 — граф деревень и дверей, дневное/ночное поведение жителей, избегание зомби, возвращение домой и размножение.

P3.11 — новый похожий на 1.2.4 terrain/biome pipeline без требования точной seed compatibility.

P3.12 — межчанковые caves, ravines, water/lava lakes.

P3.13 — recursive villages, mineshafts, strongholds и dungeons с bounding boxes и spawner metadata.

P3.14 — полный набор руд, decorators, растительность и генераторы деревьев.

Дополнительно уже сделано:
седло, езда на свинье и сохранение saddled;
доение коров и mooshroom;
mushroom stew из mooshroom;
превращение mooshroom в корову ножницами с пятью красными грибами;
все 16 блоков шерсти и рецепты с шерстью разных цветов;
предметы saddle, fish, milk bucket, ink sac и snowball;
Silverfish: AI, блоки, помощь стаи, hiding, stronghold spawner и модель;
точные руды, растения, лианы, кактусы, кувшинки, берёзы и связанные collision/drop rules.
Осталось
Цвет как состояние самой овцы: естественное распределение, наследование, сохранение, цветная стрижка и предсмертный дроп. Сейчас овца всё ещё выдаёт raw mutton, которого в 1.2.4 не было.
Категории water и ambient с caps 5/15.
Squid: водный spawn, плавание, удушье на суше, ink sac и модель.
Wolf: приручение костью, owner/sit/angry, стая, follow/teleport/attack и spawn.
Ocelot и cat-варианты: jungle spawn, flee/stalk, приручение рыбой, sit/follow и отпугивание creeper.
Cave Spider: яд, отдельная текстура, mineshaft spawner и cobweb.
Charged Creeper от молнии и удвоенная сила взрыва; окончательная доводка fuse continuation.
Более точное горение Zombie/Skeleton на солнце: случайная проверка яркости и защита головным предметом.
Iron Golem и Snow Golem: создание, AI, модели и защита деревни.