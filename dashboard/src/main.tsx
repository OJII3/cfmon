import React from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import App from './ui/App';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><MantineProvider defaultColorScheme="light"><App /></MantineProvider></React.StrictMode>,
);
