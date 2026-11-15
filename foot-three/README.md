# Penalty & coup franc — Three.js

Jeu de tir au but et de coup franc avec mur, gardien et physique réelle de la balle.

## Lancer le jeu

Les modèles 3D se chargent via HTTP, il faut donc un petit serveur local
(ouvrir `index.html` directement ne marche pas). Depuis ce dossier :

```bash
cd /Users/mathysbodennec/Developer/Jeux/foot-three
python3 -m http.server 8000
```

Puis ouvre <http://localhost:8000>. Three.js est chargé depuis un CDN, il faut donc une connexion internet.

## Commandes

Chaque tir se fait en 4 clics (ou Espace / Entrée) :

1. **Puissance** : la jauge monte et descend, clique pour la bloquer.
2. **Direction** : le viseur rouge se déplace de gauche à droite sur le but, clique pour choisir.
3. **Hauteur** : le viseur monte et descend, clique pour choisir la hauteur.
4. **Effet** : la barre d'effet oscille. Clique pour choisir la courbe (à gauche = la balle courbe à gauche, à droite = à droite).

Le bouton **Penalty** ou **Coup franc** change de situation.

## Physique

- **Gravité** et **traînée de l'air** (force proportionnelle à v²).
- **Effet Magnus** : la rotation de la balle la fait courber. Plus l'effet est fort, plus la courbe est marquée.
- **Rebonds** au sol avec perte d'énergie et frottement de roulement.
- **Mur** : 4 joueurs, qui sautent (vraie trajectoire verticale). Un tir bas peut passer sous les jambes d'un joueur qui saute.
- **Gardien** : il lit le tir (trajectoire prédite, avec une erreur de lecture et un temps de réaction), puis plonge sur le côté avec une vraie trajectoire. Son corps est une capsule de collision, qui peut dévier la balle.
- **Poteaux et barre** : collisions réelles, la balle peut rebondir dessus.

## Fichiers

```
index.html            page, HUD, import map Three.js
style.css             styles du HUD
js/physics.js         physique de la balle, collisions, calcul de trajectoire
js/characters.js      chargement des GLB, animations, orientation
js/game.js            scène, terrain, but, mur, gardien, boucle de jeu, interface
assets/characters/    modèles GLB Kenney (Mini Characters) et leurs textures
```

## Réglages utiles

- `js/game.js` : `WALL_COUNT`, `GOALIE_NOISE` (plus haut = gardien moins précis), `GOALIE_WRONG_WAY` (proba qu'il plonge du mauvais côté), `GOALIE_REACTION`.
- `js/physics.js` : `MAX_SPIN` (force de l'effet), `DRAG_COEF`, `G`.
- `js/characters.js` : `MODEL_FACING_OFFSET` à `Math.PI` si les personnages regardent dans le mauvais sens.
- `js/game.js` : les modèles utilisés sont dans `init()` (`character-male-c.glb` pour le tireur, `character-soldier.glb` pour le gardien, et `WALL_MODELS` pour le mur).

## Animations utilisées (fournies avec les GLB)

`idle`, `jump`, `fall`, `attack-kick-right`. Le plongeon est une animation physique (rotation et translation du modèle), le gardien prend la pose `fall` pendant qu'il est en l'air.
