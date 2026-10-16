"""Fundo sem a pessoa (pro parallax): apaga o recorte da foto e preenche com o entorno (inpaint).
  python3 scripts/fundo-limpo.py assets/cena1.png assets/recortes/cena1-pessoa-sem-fundo.png assets/recortes/cena1-fundo-limpo.png [manter.json]
manter.json (opcional): {"poligonos": [[[x,y],...], ...]} com regiões que NÃO podem ser pintadas (ex.: folhas no chão)."""
import sys, json, numpy as np, cv2
from PIL import Image
foto, recorte, saida = sys.argv[1:4]
im = cv2.imread(foto); al = np.asarray(Image.open(recorte).convert('RGBA'))[:, :, 3]
if al.shape != im.shape[:2]: al = cv2.resize(al, (im.shape[1], im.shape[0]), interpolation=cv2.INTER_NEAREST)
m = cv2.dilate((al > 8).astype(np.uint8) * 255, np.ones((3, 3), np.uint8), iterations=12)
if len(sys.argv) > 4:
    for poly in json.load(open(sys.argv[4])).get('poligonos', []): cv2.fillPoly(m, [np.array(poly, np.int32)], 0)
k = 4; small = cv2.resize(im, (im.shape[1] // k, im.shape[0] // k), interpolation=cv2.INTER_AREA)
ms = cv2.resize(m, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
big = cv2.resize(cv2.inpaint(small, ms, 9, cv2.INPAINT_TELEA), (im.shape[1], im.shape[0]), interpolation=cv2.INTER_CUBIC)
mf = cv2.GaussianBlur(m, (0, 0), 3).astype(float)[:, :, None] / 255
cv2.imwrite(saida, (im * (1 - mf) + big * mf).astype(np.uint8)); print('ok', saida)
