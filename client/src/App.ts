import './index.css';
import kaplay from 'kaplay';
import { createGameScene } from './scenes/game';
import { createMenuScene } from './scenes/menu';

export const k = kaplay({ background: "0a0a0f" });

createMenuScene();
createGameScene();

k.go("menu");
