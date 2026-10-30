#!/bin/bash
# Build a minimal, LGPL-only ffmpeg + ffprobe (universal: Apple Silicon + Intel, macOS 12+) for the
# Video Keeper helper into dist/ffmpeg/. yt-dlp only needs it to merge/remux streams (stream copy)
# and, for "Audio only", to convert to AAC — so everything else is disabled.
# No --enable-gpl / --enable-nonfree: the result is LGPL-2.1; we ship COPYING.LGPLv2.1 and a
# SOURCE.txt (exact source URL, checksum and configure flags) alongside the binaries.
set -euo pipefail

VERSION="8.1.3"
SHA256="7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3" # Pinned: the build fails if the archive ever changes.
URL="https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# ffmpeg's configure refuses source paths containing spaces (like "Claude Projects"), so build
# in the system temp folder and copy only the results into dist/.
WORK="${TMPDIR:-/tmp}"
WORK="${WORK%/}/video-keeper-ffmpeg-build"
OUT="$ROOT/dist/ffmpeg"
if [[ "$WORK" == *" "* ]]; then
  echo "Build folder '$WORK' contains a space; set TMPDIR to a path without spaces." >&2
  exit 1
fi

CONFIG=(
  --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug
  --disable-ffplay --disable-avdevice --disable-x86asm --enable-pic
  --enable-protocol=file,pipe
  --enable-demuxer=mov,matroska,mpegts,aac,mp3,flv,ogg,wav,h264,hevc
  --enable-muxer=mp4,mov,ipod,matroska,webm,adts,mp3,mpegts,null
  --enable-parser=aac,aac_latm,h264,hevc,av1,vp8,vp9,opus,vorbis,mpegaudio
  --enable-bsfs
  --enable-decoder=aac,aac_latm,mp3,opus,vorbis,flac,pcm_s16le
  --enable-encoder=aac
  --enable-filter=aresample,aformat,anull,null,format,copy
)

mkdir -p "$WORK" "$OUT"
cd "$WORK"
if [[ ! -f "ffmpeg-$VERSION.tar.xz" ]]; then
  curl -fL --retry 3 -o "ffmpeg-$VERSION.tar.xz.part" "$URL"
  mv "ffmpeg-$VERSION.tar.xz.part" "ffmpeg-$VERSION.tar.xz"
fi
ACTUAL="$(shasum -a 256 "ffmpeg-$VERSION.tar.xz" | cut -d' ' -f1)"
if [[ -n "$SHA256" && "$ACTUAL" != "$SHA256" ]]; then
  echo "Checksum mismatch for ffmpeg-$VERSION.tar.xz: $ACTUAL (expected $SHA256)" >&2
  exit 1
fi
[[ -z "$SHA256" ]] && echo "NOTE: no pinned checksum yet; archive SHA-256 is $ACTUAL"
rm -rf "ffmpeg-$VERSION" && tar xf "ffmpeg-$VERSION.tar.xz"

for arch in arm64 x86_64; do
  rm -rf "build-$arch" && mkdir "build-$arch" && cd "build-$arch"
  ../"ffmpeg-$VERSION"/configure "${CONFIG[@]}" \
    --arch="$arch" --target-os=darwin --enable-cross-compile \
    --cc="clang -arch $arch -mmacosx-version-min=12.0" \
    --extra-ldflags="-arch $arch -mmacosx-version-min=12.0" \
    --prefix="$WORK/install-$arch" > configure.log
  make -j"$(sysctl -n hw.ncpu)" > make.log 2>&1
  make install > install.log 2>&1
  cd ..
done

for tool in ffmpeg ffprobe; do
  lipo -create -output "$OUT/$tool" "install-arm64/bin/$tool" "install-x86_64/bin/$tool"
done
cp "ffmpeg-$VERSION/COPYING.LGPLv2.1" "$OUT/COPYING.LGPLv2.1"
cat > "$OUT/SOURCE.txt" <<EOF
FFmpeg $VERSION, built for Video Keeper (LGPL-2.1, no GPL or nonfree components).
Source: $URL
SHA-256: $ACTUAL
Configure flags: ${CONFIG[*]}
Rebuild: tools/build-ffmpeg.sh in the Video Keeper repository.
EOF
echo "Built dist/ffmpeg/ffmpeg + ffprobe ($(lipo -archs "$OUT/ffmpeg")), $(du -sh "$OUT" | cut -f1)"
