#!/usr/bin/env python3
"""
Genera imágenes con Replicate y las guarda en disco.

Uso:
    python3 herramientas/generar-imagen.py "un faro al atardecer en Cozumel" salida.png
    python3 herramientas/generar-imagen.py "logo minimalista verde neón" logo.png --modelo flux-pro --ratio 1:1

Modelos disponibles (por defecto flux-schnell, el más barato y rápido):
    flux-schnell   ~1-3 s,  buen texto corto
    flux-dev       más calidad, ~10-20 s
    flux-pro       la mejor calidad, más caro

Por qué existe: la generación de imágenes es una capacidad aparte de la visión
(el modelo de chat lee imágenes, no las crea). Replicate ya se usaba en el
despliegue de canales-youtube; este script trae esa misma capacidad al motor
para no depender de un panel.

La llave vive en REPLICATE_API_TOKEN del .env del motor.
"""
import argparse
import json
import os
import sys
import time
import urllib.request

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(RAIZ, '.env')
API = 'https://api.replicate.com/v1'

MODELOS = {
    'flux-schnell': 'black-forest-labs/flux-schnell',
    'flux-dev': 'black-forest-labs/flux-dev',
    'flux-pro': 'black-forest-labs/flux-1.1-pro',
}


def leer_token():
    token = os.environ.get('REPLICATE_API_TOKEN')
    if token:
        return token
    if os.path.exists(ENV):
        for linea in open(ENV, encoding='utf-8'):
            if linea.startswith('REPLICATE_API_TOKEN='):
                return linea.split('=', 1)[1].strip().strip('"').strip("'")
    sys.exit('Falta REPLICATE_API_TOKEN en el entorno o en el .env del motor.')


def pedir(url, token, datos=None):
    req = urllib.request.Request(url, method='POST' if datos else 'GET')
    req.add_header('Authorization', f'Bearer {token}')
    if datos:
        req.add_header('Content-Type', 'application/json')
        req.data = json.dumps(datos).encode()
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    p = argparse.ArgumentParser(description='Genera una imagen con Replicate.')
    p.add_argument('prompt', help='Descripción de la imagen')
    p.add_argument('salida', help='Ruta del archivo de salida (.png/.jpg)')
    p.add_argument('--modelo', default='flux-schnell', choices=MODELOS, help='Modelo a usar')
    p.add_argument('--ratio', default='16:9', help='Aspect ratio (1:1, 16:9, 9:16, 3:2…)')
    p.add_argument('--formato', default='png', choices=['png', 'jpg', 'webp'])
    p.add_argument('--espera', type=int, default=180, help='Segundos máximos de espera')
    args = p.parse_args()

    token = leer_token()
    modelo = MODELOS[args.modelo]

    pred = pedir(
        f'{API}/models/{modelo}/predictions',
        token,
        {'input': {'prompt': args.prompt, 'aspect_ratio': args.ratio, 'output_format': args.formato}},
    )
    url_estado = pred.get('urls', {}).get('get')
    if not url_estado:
        sys.exit(f'No se pudo crear la predicción: {json.dumps(pred)[:300]}')

    limite = time.time() + args.espera
    while time.time() < limite:
        time.sleep(3)
        est = pedir(url_estado, token)
        estado = est.get('status')
        if estado == 'succeeded':
            salida = est.get('output')
            url_img = salida[0] if isinstance(salida, list) else salida
            with urllib.request.urlopen(url_img, timeout=120) as r, open(args.salida, 'wb') as f:
                f.write(r.read())
            print(args.salida)
            return
        if estado in ('failed', 'canceled'):
            sys.exit(f'La generación falló: {est.get("error") or estado}')

    sys.exit('Timeout esperando la generación.')


if __name__ == '__main__':
    main()
