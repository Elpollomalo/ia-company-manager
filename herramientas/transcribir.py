#!/usr/bin/env python3
"""
Transcribe audio a texto con faster-whisper en el CPU del VPS (sin GPU).

Uso:
    python3 herramientas/transcribir.py audio.mp3
    python3 herramientas/transcribir.py audio.m4a --modelo small --idioma es
    python3 herramientas/transcribir.py audio.mp3 --json salida.json --texto salida.txt

Modelos (se descargan la primera vez, quedan en caché):
    tiny     ~75 MB   rápido, calidad baja
    base     ~150 MB  rápido, aceptable
    small    ~480 MB  buen equilibrio para español  <- default
    medium   ~1.5 GB  mejor, más lento en CPU
    large-v3 ~3 GB    la mejor, lento en CPU

Por qué faster-whisper y no openai-whisper: en CPU es 3-4x más rápido con
int8 y usa mucha menos memoria, sin perder calidad apreciable.

Los audios con nombres raros (espacios, caracteres invisibles) funcionan igual:
se pasan como argumento entre comillas.
"""
import argparse
import json
import os
import sys
import time


def cargar_modelo(nombre, hilos):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit('Falta faster-whisper. Instalar: pip install faster-whisper')
    return WhisperModel(nombre, device='cpu', compute_type='int8', cpu_threads=hilos)


def main():
    p = argparse.ArgumentParser(description='Transcribe audio con faster-whisper (CPU).')
    p.add_argument('audio', help='Ruta del archivo de audio o video')
    p.add_argument('--modelo', default='small', help='tiny|base|small|medium|large-v3 (default small)')
    p.add_argument('--idioma', default=None, help='Código ISO (es, en…). Si se omite, lo detecta.')
    p.add_argument('--json', dest='salida_json', help='Guardar resultado completo en JSON')
    p.add_argument('--texto', dest='salida_texto', help='Guardar solo el texto en .txt')
    p.add_argument('--hilos', type=int, default=min(6, os.cpu_count() or 4), help='Hilos de CPU')
    args = p.parse_args()

    if not os.path.exists(args.audio):
        sys.exit(f'No existe el archivo: {args.audio}')

    t0 = time.time()
    modelo = cargar_modelo(args.modelo, args.hilos)
    t_carga = time.time() - t0

    t1 = time.time()
    segmentos, info = modelo.transcribe(
        args.audio,
        language=args.idioma,
        beam_size=5,
        vad_filter=True,               # recorta silencios: menos alucinaciones
        vad_parameters={'min_silence_duration_ms': 500},
    )
    trozos = []
    for s in segmentos:
        trozos.append({'inicio': round(s.start, 2), 'fin': round(s.end, 2), 'texto': s.text.strip()})
    t_trans = time.time() - t1

    texto = ' '.join(t['texto'] for t in trozos).strip()
    duracion = getattr(info, 'duration', None) or 0

    if args.salida_texto:
        with open(args.salida_texto, 'w', encoding='utf-8') as f:
            f.write(texto + '\n')
    if args.salida_json:
        with open(args.salida_json, 'w', encoding='utf-8') as f:
            json.dump({
                'archivo': args.audio,
                'modelo': args.modelo,
                'idioma_detectado': getattr(info, 'language', None),
                'probabilidad_idioma': round(getattr(info, 'language_probability', 0) or 0, 3),
                'duracion_audio_s': round(duracion, 2),
                'segundos_transcripcion': round(t_trans, 2),
                'segmentos': trozos,
                'texto': texto,
            }, f, ensure_ascii=False, indent=2)

    # Resumen a stdout (lo que se lee en el chat)
    print(f'archivo: {args.audio}')
    print(f'modelo: {args.modelo} | idioma: {getattr(info, "language", "?")} '
          f'({round((getattr(info, "language_probability", 0) or 0) * 100)}%)')
    print(f'duración: {duracion:.1f}s | carga modelo: {t_carga:.1f}s | transcripción: {t_trans:.1f}s '
          f'({(duracion / t_trans):.1f}x tiempo real)' if t_trans > 0 else '')
    print(f'segmentos: {len(trozos)}')
    print('---')
    print(texto)


if __name__ == '__main__':
    main()
