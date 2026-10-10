// Gera assets/trilha.wav com os cortes do reel (início de cada cena depois da primeira).
import { gerarTrilha } from './trilha.mjs'
const DURACAO = 47.5
const CORTES = [3.5, 8.5, 14.5, 20, 24.5, 29, 33.5, 38, 42.5]
gerarTrilha({ duracao: DURACAO, cortes: CORTES, arquivo: new URL('../assets/trilha.wav', import.meta.url).pathname })
