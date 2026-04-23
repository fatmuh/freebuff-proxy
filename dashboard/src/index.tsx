import { render } from 'solid-js/web'
import { Router, Route } from '@solidjs/router'
import './index.css'
import App from './App'
import HomePage from './components/HomePage'
import AccountsPanel from './components/AccountsPanel'
import ApiKeysPanel from './components/ApiKeysPanel'
import RequestsPage from './components/RequestsPage'

const root = document.getElementById('root')
if (!root) throw new Error('root element not found')

render(() => (
  <Router root={App}>
    <Route path="/" component={HomePage} />
    <Route path="/accounts" component={AccountsPanel} />
    <Route path="/keys" component={ApiKeysPanel} />
    <Route path="/requests" component={RequestsPage} />
  </Router>
), root)
