#!/usr/bin/env bash
# Isole un job du runner auto-hébergé partagé, puis récupère tout ce qu'il a
# laissé derrière lui.
#
# Les trois instances `canary-ci` tournent sous le même utilisateur `gh-runner`
# dans le CT 126 : elles partagent `/tmp` — un tmpfs, donc de la RAM — et
# `~/.canary`, où vit le socket du démon Canary. Mesuré le 31 octobre 2026 : un
# démon lancé par un test survivait depuis 10 jours avec 42 `chrome-headless` et
# 232 `ffmpeg`, et 77 488 dossiers de tests occupaient 20 Go de `/tmp`. Les trois
# runners ont été tués par l'OOM pendant `check`.
#
#   setup [--home]  marque le job (CANARY_CI_JOB), lui donne un TMPDIR sur disque
#                   sous RUNNER_TEMP et, avec --home, un HOME à lui : le démon
#                   Canary et ses navigateurs n'y sont plus partagés entre jobs.
#   prune CMD...    lance un nettoyage Docker partagé (`docker image prune`…) :
#                   le démon Docker est commun aux jobs, et deux nettoyages
#                   simultanés font échouer le second (« a prune operation is
#                   already running », run 41135555436). Trois essais, puis un
#                   avertissement : récupérer du disque ne doit pas faire échouer
#                   le job.
#   reap            tue les processus qui portent le marqueur de CE job (démon,
#                   Chromium, ffmpeg détachés), jamais ceux d'un job voisin, puis
#                   supprime ses dossiers.
set -euo pipefail

root="${RUNNER_TEMP:?RUNNER_TEMP is only set inside a GitHub Actions job}/job-isolation"

setup() {
  mkdir -p "$root/tmp"
  {
    # Hérité par chaque processus lancé ensuite, y compris un démon détaché
    # (setsid) : c'est ce qui permet à `reap` de le retrouver, et lui seul.
    echo "CANARY_CI_JOB=${RUNNER_NAME}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}"
    # Sur disque et vidé par le runner à chaque job, au lieu du /tmp en RAM.
    # Court : Chromium y crée des sockets Unix, limités à 108 caractères.
    echo "TMPDIR=$root/tmp"
  } >> "$GITHUB_ENV"
  if [ "${1:-}" = "--home" ]; then
    mkdir -p "$root/home"
    {
      # Les navigateurs restent ceux du cache partagé, installés avant cette
      # étape : un HOME vide les ferait sinon retélécharger à chaque job.
      echo "PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
      echo "HOME=$root/home"
    } >> "$GITHUB_ENV"
  fi
  echo "Job isolated under $root"
}

# PID et ancêtres du shell courant : ils portent aussi le marqueur, mais ce sont
# l'étape elle-même et le runner.
ancestors() {
  local pid=$BASHPID
  while [ "$pid" -gt 1 ]; do
    echo "$pid"
    pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null) || break
  done
}

marked() {
  local marker="CANARY_CI_JOB=${CANARY_CI_JOB:?setup was not run in this job}"
  local skip
  skip=" $(ancestors | tr '\n' ' ') "
  local entry pid
  for entry in /proc/[0-9]*; do
    pid=${entry#/proc/}
    case "$skip" in *" $pid "*) continue ;; esac
    # Lisible seulement pour les processus de cet utilisateur : ceux de root ou
    # d'un autre compte ne sont jamais candidats.
    if tr '\0' '\n' < "$entry/environ" 2>/dev/null | grep -qxF "$marker"; then
      echo "$pid"
    fi
  done
}

reap() {
  local pids
  pids=$(marked || true)
  if [ -n "$pids" ]; then
    echo "Stopping $(echo "$pids" | wc -l) process(es) left by this job:"
    # shellcheck disable=SC2086
    ps -o pid=,etimes=,comm= -p $(echo $pids | tr ' ' ',') || true
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    sleep 5
    pids=$(marked || true)
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill -KILL $pids 2>/dev/null || true
    fi
  else
    echo "No process left by this job."
  fi
  if [ -d "$root" ]; then
    chmod -R u+w "$root" 2>/dev/null || true
    rm -rf "$root"
  fi
}

prune() {
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then
      return 0
    fi
    echo "Attempt $attempt of '$*' failed (a sibling job may be pruning); retrying in 10 s"
    sleep 10
  done
  echo "::warning::'$*' failed three times; the disk will be reclaimed by a later job"
}

case "${1:-}" in
  setup) shift; setup "$@" ;;
  reap) reap ;;
  prune) shift; prune "$@" ;;
  *) echo "usage: $0 setup [--home] | reap | prune CMD..." >&2; exit 2 ;;
esac
