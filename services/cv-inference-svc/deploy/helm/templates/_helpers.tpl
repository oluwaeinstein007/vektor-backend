{{- define "cv-inference-svc.name" -}}
cv-inference-svc
{{- end -}}

{{/*
Fixed to the plain service name, not templated on .Release.Name — SEC-001's
deferred Istio AuthorizationPolicy work (see vektor-infra's istio module and
ADR-0012) needs a predictable per-service ServiceAccount identity to write
allow-rules against, which a release-name-dependent name would undermine.
*/}}
{{- define "cv-inference-svc.fullname" -}}
cv-inference-svc
{{- end -}}

{{- define "cv-inference-svc.labels" -}}
app.kubernetes.io/name: {{ include "cv-inference-svc.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "cv-inference-svc.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cv-inference-svc.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "cv-inference-svc.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "cv-inference-svc.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
