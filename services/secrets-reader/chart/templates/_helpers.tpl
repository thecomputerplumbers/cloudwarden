{{- define "cloudwarden-secrets.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "cloudwarden-secrets.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "cloudwarden-secrets.selector" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- /*
The port is always written out: External Secrets Operator validates a webhook store by dialing its
URL's host, and takes a missing port as 443 whatever the scheme (esutils.NetworkValidate, v2.14).
*/ -}}
{{- define "cloudwarden-secrets.url" -}}
http://{{ include "cloudwarden-secrets.fullname" . }}.{{ .Release.Namespace }}.svc:{{ .Values.service.port }}
{{- end -}}
