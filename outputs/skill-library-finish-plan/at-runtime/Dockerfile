FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    LANG=de_DE.UTF-8 \
    LC_ALL=de_DE.UTF-8 \
    NO_AT_BRIDGE=0 \
    GTK_MODULES=gail:atk-bridge \
    XDG_RUNTIME_DIR=/tmp/xdg-runtime

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      xvfb dbus-x11 at-spi2-core python3-pyatspi \
      orca speech-dispatcher speech-dispatcher-espeak-ng espeak-ng \
      chromium xdotool imagemagick fonts-dejavu fonts-noto-core \
      pulseaudio pulseaudio-utils locales ca-certificates procps psmisc \
      python3-tk openbox x11-utils \
    && sed -i 's/^# *de_DE.UTF-8/de_DE.UTF-8/' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# Speech Dispatcher: a generic output module that records the exact text the
# assistive technology hands to the speech engine, so announcements are captured
# from the real pipeline rather than reconstructed.
COPY korylog.conf /etc/speech-dispatcher/modules/korylog.conf
COPY speechd.conf /etc/speech-dispatcher/speechd.conf

WORKDIR /work
CMD ["bash"]
