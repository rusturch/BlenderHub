import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    // no externalizeDepsPlugin: the sandboxed preload cannot require node_modules
    // at runtime, so its dependencies must be bundled in
    plugins: []
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/blender-api/daily': {
          target: 'https://builder.blender.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/blender-api\/daily/, '/download/daily/')
        },
        '/blender-api/experimental': {
          target: 'https://builder.blender.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/blender-api\/experimental/, '/download/experimental/')
        },
        '/blender-api/patch': {
          target: 'https://builder.blender.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/blender-api\/patch/, '/download/patch/')
        },
        '/blender-api/release': {
          target: 'https://download.blender.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/blender-api\/release/, '/release')
        }
      }
    }
  }
})
