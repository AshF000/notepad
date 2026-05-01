import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './', // Important for Electron builds
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Offline Notepad',
        short_name: 'Notepad',
        description: 'Offline-First Synced Notepad',
        theme_color: '#1e1e1e',
        background_color: '#1e1e1e',
        display: 'standalone',
        icons: [
          {
            src: 'https://cdn-icons-png.flaticon.com/512/732/732220.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ]
})
