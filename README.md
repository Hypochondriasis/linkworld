# Linkworld

A Quake-like browser FPS where every level is a link. The whole level (geometry, procedural textures,
entities) is binary-encoded, compressed and stored in the URL fragment. No backend, no assets, no build step.

## Features

- Quake-style movement, brush collision, doors, triggers and exits
- Procedural textures with normal maps, baked lightmaps with shadows
- Particles, emitters and models
- Built-in level editor (2D grids, 3D view, texture, particle and model screens)
- A single link can hold a whole pack of levels

## Run

Serve the folder with any static server, then open it in a browser:

```sh
python3 -m http.server
```

- `index.html` plays a level (or shows the menu)
- `editor.html` builds one

## Test

```sh
node --test
```

## Tech

Vanilla JavaScript ES modules and WebGL 1. No frameworks, dependencies or bundler.
