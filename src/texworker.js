// Module worker for generateTexturesAsync: one recipe list in, its images out.
import { generateTextures } from './texgen.js';

onmessage = (e) => postMessage(generateTextures(e.data));
