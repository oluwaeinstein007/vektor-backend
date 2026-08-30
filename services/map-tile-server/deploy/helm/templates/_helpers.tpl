{{- define "map-tile-server.name" -}}
map-tile-server
{{- end -}}

{{/*
Fixed to the plain service name, not templated on .Release.Name — SEC-001's
deferred Istio AuthorizationPolicy work (see vektor-infra's istio module and
ADR-0012) needs a predictable per-service ServiceAccount identity to write
allow-rules against, which a release-name-dependent name would undermine.
*/}}
{{- define "map-tile-server.fullname" -}}
map-tile-server
{{- end -}}

{{- define "map-tile-server.labels" -}}
app.kubernetes.io/name: {{ include "map-tile-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "map-tile-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "map-tile-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "map-tile-server.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "map-tile-server.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
